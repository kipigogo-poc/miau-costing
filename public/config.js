// Firebase web config (Firebase console → Project settings → Your apps → Web app).
// This identifies the project; it is not a secret. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyBjgviL-b_H1LSl_00xO9GKGhO4zvqtf_A",
  authDomain: "miauxeveryday.firebaseapp.com",
  projectId: "miauxeveryday",
  storageBucket: "miauxeveryday.firebasestorage.app",
  messagingSenderId: "41634615908",
  appId: "1:41634615908:web:f90048d36d7f76b4f7c571"
};

// Your shop. Later, each branch can get its own id (e.g. "branch-2").
export const SHOP_ID = "main";

// Shown on the sign-in screen only. Real access control is in firestore.rules.
export const SHOP_NAME = "miauxeveryday";

// Where each free "Adopt a cat" button sends people (Instagram post or reel). A cat without its own link uses "default".
export const INSTAGRAM = {
  solaire: "https://www.instagram.com/reel/DeZCpGBy_Nh/",
  lucy: "https://www.instagram.com/reel/DebSOMFS7xS/",
  muzan: "https://www.instagram.com/reel/DeeJaSiyZxi/",
  riri: "https://www.instagram.com/reel/DeeJaSiyZxi/",
  default: "https://www.instagram.com/reel/DeZCpGBy_Nh/"
};
