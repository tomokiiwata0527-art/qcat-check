// 保存層：Firebase設定があればFirebase、なければ端末内(IndexedDB)。
// どちらも同じAPI：
//   mode, init(), user, signIn(), signOut(), save(rec, photoBlob, overlayBlob),
//   list(from, to), imageUrl(rec, 'photo'|'overlay'), review(id, patch)
import { firebaseConfig } from './firebase-config.js';

// 画像を縮小してJPEGのdataURLにする（Firestore 1ドキュメント1MiB制限に収めるため）
export async function shrinkToDataUrl(blob, maxLong, maxChars = 900000) {
  const bmp = await createImageBitmap(blob);
  let long = maxLong;
  for (let i = 0; i < 6; i++) {
    const k = Math.min(1, long / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.8, 0.7, 0.6, 0.5]) { const u = c.toDataURL('image/jpeg', q); if (u.length <= maxChars) return u; }
    long = Math.round(long * 0.8);
  }
  throw Object.assign(new Error('image-too-large'), { code: 'image-too-large' });
}

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
  // Storage（有料のBlazeプランが必要）を使わず、縮小した画像をFirestoreに保存する
  async save(rec, imgs) {
    const { doc, setDoc, writeBatch } = this.m;
    rec.createdBy = this.user.uid; rec.createdByEmail = this.user.email;
    rec.imgMode = 'fs';
    const step = async (name, fn) => { try { return await fn(); } catch (e) { e.code = (e.code || 'error') + '@' + name; e.message = name + ': ' + (e.message || ''); throw e; } };
    const data = {};
    for (const [k, mx] of [['photo', 1280], ['shot', 900], ['overlay', 1056]]) data[k] = await step('縮小:' + k, () => shrinkToDataUrl(imgs[k], mx));
    for (const k of ['photo', 'shot', 'overlay']) await step('画像:' + k + '(' + data[k].length + ')', () => setDoc(doc(this.fs, 'measurements', rec.id, 'images', k), { data: data[k] }));
    await step('記録', () => setDoc(doc(this.fs, 'measurements', rec.id), JSON.parse(JSON.stringify(rec))));   // undefinedを除去
    this.urls.set(rec.id + '/photo', data.photo); this.urls.set(rec.id + '/shot', data.shot); this.urls.set(rec.id + '/overlay', data.overlay);
    return rec;
  }
  async list(from, to) {
    const { collection, query, where, orderBy, getDocs } = this.m;
    const q = query(collection(this.fs, 'measurements'), where('date', '>=', from), where('date', '<=', to), orderBy('date'));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async imageUrl(rec, kind) {
    const key = rec.id + '/' + kind;
    if (this.urls.has(key)) return this.urls.get(key);
    let u = '';
    if (rec.imgMode === 'fs') {
      const d = await this.m.getDoc(this.m.doc(this.fs, 'measurements', rec.id, 'images', kind));
      u = d.exists() ? d.data().data : '';
    } else {
      const path = { photo: rec.photoPath, shot: rec.shotPath, overlay: rec.overlayPath }[kind];
      if (!path) return '';
      u = await this.m.getDownloadURL(this.m.ref(this.st, path));
    }
    this.urls.set(key, u); return u;
  }
  async review(id, patch) {
    await this.m.updateDoc(this.m.doc(this.fs, 'measurements', id), patch);
  }
}

export function createStore() {
  return firebaseConfig && firebaseConfig.apiKey ? new FirebaseStore(firebaseConfig) : new LocalStore();
}
