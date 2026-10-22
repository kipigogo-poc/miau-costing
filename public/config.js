// Firebase web config (Firebase console → Project settings → Your apps → Web app).
// This identifies the project; it is not a secret. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyBXz_ITdVn_92oAZrNEDEZ4ElioFktMo-M",
  authDomain: "miaucoffee.firebaseapp.com",
  projectId: "miaucoffee",
  storageBucket: "miaucoffee.firebasestorage.app",
  messagingSenderId: "291350773104",
  appId: "1:291350773104:web:9c833fcaaa3a2982eb23b5"
};

// Your shop. Later, each branch can get its own id (e.g. "branch-2").
export const SHOP_ID = "main";

// Shown on the sign-in screen only. Real access control is in firestore.rules.
export const SHOP_NAME = "miauxeveryday";
