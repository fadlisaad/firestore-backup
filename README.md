# Automated Firebase, Firestore & Storage Offline Backup Tool

A complete Node.js backup suite to download and save offline backups for:
- 🗄️ **All Cloud Firestore Databases** (`(default)`, `pemilihan`, `perwakilan`, `staging`, `voting`)
- 📦 **Firebase Cloud Storage Buckets** (`gs://adil-app-dd510.firebasestorage.app`)
- ⚡ **Firebase Realtime Database** (`DB_URL`)

---

## Features

- 🔍 **Pre-Flight Dry-Run**: Fast scan mode that counts documents/files, estimates sizes, and inspects folder structures without downloading or saving files.
- 🌳 **Firestore Subcollection Support**: Traverses collections and nested subcollections at any depth using memory-safe streaming.
- 📦 **Storage Incremental Sync**: Downloads Storage files preserving folder structures, skipping unchanged files via size/hash comparison.
- 🎯 **Folder & Prefix Filtering**: Target specific storage folders (e.g. `--prefix=nomination/`) or specific Firestore databases (e.g. `--db=voting`).
- ⏱️ **Real-Time Elapsed Time**: Active timer (`MM:SS.s`) and speed indicator during download.
- 💾 **Structured Backups**: Organized per database and bucket with timestamped sessions and `latest/` folders.
- 📊 **Summary Reports**: Clear audit summary with total files, document counts, sizes, and elapsed times.

---

## Commands

### 🔍 Dry-Run Modes (Fast inspection, zero disk write)
```bash
# Dry-run Firestore + Storage
npm run backup:dry

# Dry-run Storage bucket only
npm run backup:storage:dry

# Dry-run a specific folder in Storage
node index.js --storage --dry-run --prefix=nomination/
```

### 💾 Backup Modes
```bash
# Backup all Firestore databases
npm run backup

# Backup a specific Firestore database
node index.js --db=voting
node index.js --db=pemilihan
node index.js --db=perwakilan
node index.js --db=staging

# Backup all Firebase Storage files
npm run backup:storage

# Backup a specific folder in Firebase Storage
node index.js --storage --prefix=nomination/
node index.js --storage --prefix=appeal/
node index.js --storage --prefix=kongres-receipt/

# Backup everything (Firestore + Storage + RTDB)
npm run backup:all

# Backup Realtime Database only
npm run backup:rtdb
```

---

## Configuration (`.env`)

```env
# Cloud Firestore Databases
FIRESTORE_DATABASES=(default),pemilihan,perwakilan,staging,voting

# Firebase Cloud Storage Bucket
FIREBASE_STORAGE=gs://adil-app-dd510.firebasestorage.app

# Firebase Realtime Database
DB_URL=https://adil-app-dd510-default-rtdb.asia-southeast1.firebasedatabase.app

# Service Account Key
PRIVATE_KEY=adil-app-dd510-firebase-adminsdk-jc7a1-1ae753c739.json
```
