// 1) Paste your Firebase web config here (Firebase console → Project settings → Your apps → Web app).
// 2) Set authDomain to your site's domain (e.g. "your-project.web.app") so Google sign-in works on iPhone Safari.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "your-project.web.app",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Your shop. Later, each branch can get its own id (e.g. "branch-2").
export const SHOP_ID = "main";

// Shown on the sign-in screen only. Real access control is in firestore.rules.
export const SHOP_NAME = "My Coffee Shop";
