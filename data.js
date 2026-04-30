// ===================================================================
// PIKE Attendance — Firestore Data Layer
// -------------------------------------------------------------------
// All database reads/writes go through this module. The rest of the
// app calls db.events.create(...), db.roster.subscribe(...), etc.
// ===================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

// ---- Initialize ----
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs   = getFirestore(app);
const provider = new GoogleAuthProvider();

// ===================================================================
// AUTH
// ===================================================================
export const authApi = {
  current: () => auth.currentUser,
  isExec: () => !!auth.currentUser, // Firestore rules enforce real exec check
  signIn: () => signInWithPopup(auth, provider),
  signOut: () => signOut(auth),
  onChange: (cb) => onAuthStateChanged(auth, cb),
};

// ===================================================================
// EVENTS
// ===================================================================
export const events = {
  subscribe(callback) {
    const q = query(collection(fs, "events"), orderBy("date", "desc"));
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async create(event) {
    const ref = await addDoc(collection(fs, "events"), {
      name:     event.name,
      type:     event.type,
      date:     event.date,
      location: event.location || "",
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser ? auth.currentUser.email : null,
    });
    return ref.id;
  },

  async remove(eventId) {
    // Delete the event AND all its check-ins, transactionally.
    // We grab check-ins via a one-time read, then batch-delete.
    const { getDocs, where } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const ciSnap = await getDocs(
      query(collection(fs, "checkins"), where("eventId", "==", eventId))
    );
    const batch = writeBatch(fs);
    ciSnap.forEach(d => batch.delete(d.ref));
    batch.delete(doc(fs, "events", eventId));
    await batch.commit();
  },
};

// ===================================================================
// ROSTER
// ===================================================================
export const roster = {
  subscribe(callback) {
    const q = query(collection(fs, "roster"), orderBy("lastName"));
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ key: d.id, ...d.data() }));
      callback(list);
    });
  },

  brotherKey(b) {
    return (b.firstName + "_" + b.lastName)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
  },

  async upsert(brother) {
    const key = this.brotherKey(brother);
    await setDoc(doc(fs, "roster", key), {
      firstName: brother.firstName,
      lastName:  brother.lastName,
      status:    brother.status || "Active",
      email:     brother.email  || "",
    });
    return key;
  },

  async remove(key) {
    await deleteDoc(doc(fs, "roster", key));
  },

  async bulkReplace(newRoster) {
    // Wipe and replace. Used by Import → Replace All.
    const { getDocs } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const existing = await getDocs(collection(fs, "roster"));
    // Firestore batches are limited to 500 ops, so we chunk.
    const allOps = [];
    existing.forEach(d => allOps.push({ type: "delete", ref: d.ref }));
    newRoster.forEach(b => {
      const key = this.brotherKey(b);
      allOps.push({
        type: "set",
        ref:  doc(fs, "roster", key),
        data: {
          firstName: b.firstName,
          lastName:  b.lastName,
          status:    b.status || "Active",
          email:     b.email  || "",
        },
      });
    });
    for (let i = 0; i < allOps.length; i += 400) {
      const batch = writeBatch(fs);
      allOps.slice(i, i + 400).forEach(op => {
        if (op.type === "delete") batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      await batch.commit();
    }
  },

  async bulkMerge(incoming) {
    // Add new brothers, update existing ones, leave the rest alone.
    const ops = incoming.map(b => ({
      ref:  doc(fs, "roster", this.brotherKey(b)),
      data: {
        firstName: b.firstName,
        lastName:  b.lastName,
        status:    b.status || "Active",
        email:     b.email  || "",
      },
    }));
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(fs);
      ops.slice(i, i + 400).forEach(op => batch.set(op.ref, op.data, { merge: true }));
      await batch.commit();
    }
  },
};

// ===================================================================
// CHECK-INS
// ===================================================================
export const checkins = {
  subscribe(callback) {
    const q = query(collection(fs, "checkins"), orderBy("timestamp", "desc"));
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async create(payload) {
    return await addDoc(collection(fs, "checkins"), {
      eventId:    payload.eventId,
      brotherKey: payload.brotherKey,
      name:       payload.name,
      status:     payload.status || "",
      email:      payload.email  || "",
      timestamp:  Date.now(),
    });
  },

  async remove(checkinId) {
    await deleteDoc(doc(fs, "checkins", checkinId));
  },
};
