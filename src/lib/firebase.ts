import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDoi750NzXB5KWXU8oDWr4scJZ0mf_2mWU",
  authDomain: "gmxlabtr.firebaseapp.com",
  databaseURL: "https://gmxlabtr-default-rtdb.firebaseio.com",
  projectId: "gmxlabtr",
  storageBucket: "gmxlabtr.firebasestorage.app",
  messagingSenderId: "779740910958",
  appId: "1:779740910958:web:45afeef855ec008a025d7f",
  measurementId: "G-SM7PRHBWQL"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export default app;
