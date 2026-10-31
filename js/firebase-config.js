// Firebaseコンソール →「プロジェクトの設定」→「マイアプリ(Web)」に表示される設定値を貼り付けてください。
// 空のままなら「端末内保存モード」で動作します（この端末のブラウザにだけ保存。共有はされません）。
// ※ apiKey は公開されても問題ない識別子です。実際の保護は firestore.rules / storage.rules とログインで行います。
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
