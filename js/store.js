// 保存層：Firebase設定があればFirebase、なければ端末内(IndexedDB)。
// どちらも同じAPI：
//   mode, init(), user, signIn(), signOut(), save(rec, photoBlob, overlayBlob),
//   list(from, to), imageUrl(rec, 'photo'|'overlay'), review(id, patch)
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';

// ---------------- 端末内保存 ----------------
class LocalStore {
  constructor() { this.mode = 'local'; this.user = { email: 'この端末', isAdmin: true, uid: 'local' }; this.urls = new Map(); }
  async init() {
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('qcat', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('measurements', { keyPath: 'id' });
        r.result.createObjectStore('blobs');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.user;
  }
  _tx(stores, mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(stores, mode); let out;
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      out = fn(tx);
    });
  }
  async signIn() { return this.user; }
  async signOut() {}
  async save(rec, imgs) {
    rec.createdBy = 'local'; rec.createdByEmail = this.user.email;
    await this._tx(['measurements', 'blobs'], 'readwrite', tx => {
      tx.objectStore('blobs').put(imgs.photo, rec.id + '/photo');
      tx.objectStore('blobs').put(imgs.shot, rec.id + '/shot');
      tx.objectStore('blobs').put(imgs.overlay, rec.id + '/overlay');
      tx.objectStore('measurements').put(rec);
    });
    return rec;
  }
  async list(from, to) {
    const all = await new Promise((res, rej) => {
      const r = this.db.transaction('measurements').objectStore('measurements').getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return all.filter(r => r.date >= from && r.date <= to).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async imageUrl(rec, kind) {
    const key = rec.id + '/' + kind;
    if (this.urls.has(key)) return this.urls.get(key);
    const blob = await new Promise((res, rej) => {
      const r = this.db.transaction('blobs').objectStore('blobs').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (!blob) return '';
    const u = URL.createObjectURL(blob); this.urls.set(key, u); return u;
  }
  async review(id, patch) {
    await this._tx(['measurements'], 'readwrite', tx => {
      const s = tx.objectStore('measurements'), g = s.get(id);
      g.onsuccess = () => s.put({ ...g.result, ...patch });
    });
  }
}

// ---------------- Firebase ----------------
class FirebaseStore {
  constructor(cfg) { this.mode = 'firebase'; this.cfg = cfg; this.user = null; this.urls = new Map(); }
  async init() {
    const [app, auth, fs, st] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'), import(FB + 'firebase-storage.js'),
    ]);
    this.m = { ...app, ...auth, ...fs, ...st };
    this.app = this.m.initializeApp(this.cfg);
    this.auth = this.m.getAuth(this.app);
    this.fs = this.m.getFirestore(this.app);
    this.st = this.m.getStorage(this.app);
    this.st.maxUploadRetryTime = 20000; this.st.maxOperationRetryTime = 20000;
    await new Promise(res => {
      const off = this.m.onAuthStateChanged(this.auth, async u => { await this._setUser(u); off(); res(); });
    });
    return this.user;
  }
  async _setUser(u) {
    if (!u) { this.user = null; return; }
    let isAdmin = false;
    try { isAdmin = (await this.m.getDoc(this.m.doc(this.fs, 'admins', u.uid))).exists(); } catch { /* ルール上読めない=非管理者 */ }
    this.user = { uid: u.uid, email: u.email, isAdmin };
  }
  async signIn(email, pw) {
    const c = await this.m.signInWithEmailAndPassword(this.auth, email, pw);
    await this._setUser(c.user); return this.user;
  }
  async signOut() { await this.m.signOut(this.auth); this.user = null; }
  async save(rec, imgs) {
    const { ref, uploadBytes, doc, setDoc } = this.m;
    rec.createdBy = this.user.uid; rec.createdByEmail = this.user.email;
    rec.photoPath = `measurements/${rec.id}/photo.jpg`; rec.shotPath = `measurements/${rec.id}/shot.jpg`; rec.overlayPath = `measurements/${rec.id}/overlay.jpg`;
    await uploadBytes(ref(this.st, rec.photoPath), imgs.photo, { contentType: 'image/jpeg' });
    await uploadBytes(ref(this.st, rec.shotPath), imgs.shot, { contentType: 'image/jpeg' });
    await uploadBytes(ref(this.st, rec.overlayPath), imgs.overlay, { contentType: 'image/jpeg' });
    await setDoc(doc(this.fs, 'measurements', rec.id), rec);
    return rec;
  }
  async list(from, to) {
    const { collection, query, where, orderBy, getDocs } = this.m;
    const q = query(collection(this.fs, 'measurements'), where('date', '>=', from), where('date', '<=', to), orderBy('date'));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async imageUrl(rec, kind) {
    const path = { photo: rec.photoPath, shot: rec.shotPath, overlay: rec.overlayPath }[kind];
    if (!path) return '';
    if (this.urls.has(path)) return this.urls.get(path);
    const u = await this.m.getDownloadURL(this.m.ref(this.st, path)); this.urls.set(path, u); return u;
  }
  async review(id, patch) {
    await this.m.updateDoc(this.m.doc(this.fs, 'measurements', id), patch);
  }
}

export function createStore() {
  return firebaseConfig && firebaseConfig.apiKey ? new FirebaseStore(firebaseConfig) : new LocalStore();
}
