const admin = require("firebase-admin");
const { getFirestore, Timestamp, GeoPoint } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Helper to format elapsed time in MM:SS.s
function formatElapsedTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    const paddedMins = String(mins).padStart(2, '0');
    const paddedSecs = String(secs).padStart(2, '0');
    return `${paddedMins}:${paddedSecs}.${ms}s (${seconds.toFixed(1)}s)`;
}

// Helper to format byte sizes
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Convert Firestore specific objects to JSON-serializable structures
function serializeFirestoreData(val) {
    if (val === null || val === undefined) return val;
    if (val instanceof Timestamp) {
        return {
            _type: 'Timestamp',
            iso: val.toDate().toISOString(),
            seconds: val.seconds,
            nanoseconds: val.nanoseconds
        };
    }
    if (val instanceof GeoPoint) {
        return {
            _type: 'GeoPoint',
            latitude: val.latitude,
            longitude: val.longitude
        };
    }
    if (typeof val === 'object' && val.constructor && val.constructor.name === 'DocumentReference') {
        return {
            _type: 'DocumentReference',
            path: val.path
        };
    }
    if (Buffer.isBuffer(val)) {
        return {
            _type: 'Bytes',
            base64: val.toString('base64')
        };
    }
    if (Array.isArray(val)) {
        return val.map(serializeFirestoreData);
    }
    if (typeof val === 'object') {
        const res = {};
        for (const [k, v] of Object.entries(val)) {
            res[k] = serializeFirestoreData(v);
        }
        return res;
    }
    return val;
}

// Find service account credential file
function getServiceAccount() {
    const envKeyPath = process.env.PRIVATE_KEY || process.env.SERVICE_ACCOUNT_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envKeyPath) {
        const resolvedPath = path.isAbsolute(envKeyPath) ? envKeyPath : path.join(__dirname, envKeyPath);
        if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
        }
    }

    // Search directory for standard firebase service account json
    const files = fs.readdirSync(__dirname);
    const found = files.find(f => f.includes("firebase-adminsdk") && f.endsWith(".json"));
    if (found) {
        return path.join(__dirname, found);
    }

    throw new Error("Service account JSON key file could not be found. Please check your .env or directory.");
}

// Get clean bucket name from environment
function getStorageBucketName() {
    const raw = process.env.FIREBASE_STORAGE || process.env.STORAGE_BUCKET || "gs://adil-app-dd510.firebasestorage.app";
    return raw.replace(/^gs:\/\//, '').trim();
}

// Dry-run function for a Firestore database
async function dryRunFirestoreDatabase(app, dbId) {
    const dbLabel = dbId === '(default)' ? '(default)' : dbId;
    const startTime = Date.now();
    const firestoreInstance = (dbId === '(default)' || !dbId) 
        ? getFirestore(app) 
        : getFirestore(app, dbId);

    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;

    const timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
        process.stdout.write(`\r  ${frame} [Firestore: ${dbLabel}] Scanning collections... [Elapsed: ${formatElapsedTime(elapsedSec)}]`);
    }, 100);

    try {
        const collections = await firestoreInstance.listCollections();
        const collectionDetails = [];
        let totalDocs = 0;

        for (const col of collections) {
            let count = 0;
            try {
                const countSnapshot = await col.count().get();
                count = countSnapshot.data().count;
            } catch (countErr) {
                const metaSnapshot = await col.select().get();
                count = metaSnapshot.size;
            }
            totalDocs += count;
            collectionDetails.push({ name: col.id, count });
        }

        clearInterval(timerInterval);
        const elapsedSec = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r  ✔ [Firestore: ${dbLabel}] Found ${collections.length} collection(s), ~${totalDocs.toLocaleString()} doc(s) in ${elapsedSec.toFixed(2)}s\n`);

        return {
            databaseId: dbLabel,
            status: 'OK',
            collectionsCount: collections.length,
            documentsCount: totalDocs,
            collections: collectionDetails,
            duration: elapsedSec
        };
    } catch (err) {
        clearInterval(timerInterval);
        process.stdout.write(`\r  ✖ [Firestore: ${dbLabel}] DRY-RUN FAILED: ${err.message}\n`);
        return {
            databaseId: dbLabel,
            status: 'ERROR',
            error: err.message,
            duration: (Date.now() - startTime) / 1000
        };
    }
}

// Memory-safe stream dry-run for Firebase Storage using getFilesStream()
async function dryRunStorage(app, prefix = '') {
    const bucketName = getStorageBucketName();
    const startTime = Date.now();
    const storage = getStorage(app);
    const bucket = storage.bucket(bucketName);

    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    const folderBreakdown = {};

    const timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
        process.stdout.write(`\r  ${frame} [Storage: ${bucketName}] Scanned ${totalFiles.toLocaleString()} files (${formatBytes(totalBytes)}) [Elapsed: ${formatElapsedTime(elapsedSec)}]`);
    }, 100);

    try {
        await new Promise((resolve, reject) => {
            const streamOptions = prefix ? { prefix } : {};
            const stream = bucket.getFilesStream(streamOptions);

            stream.on('data', (file) => {
                totalFiles++;
                const size = parseInt(file.metadata ? file.metadata.size || '0' : '0', 10);
                totalBytes += size;

                const parts = file.name.split('/');
                const topFolder = parts.length > 1 ? parts[0] : '(root files)';
                if (!folderBreakdown[topFolder]) {
                    folderBreakdown[topFolder] = { count: 0, bytes: 0 };
                }
                folderBreakdown[topFolder].count++;
                folderBreakdown[topFolder].bytes += size;
            });

            stream.on('end', () => resolve());
            stream.on('error', (err) => reject(err));
        });

        clearInterval(timerInterval);
        const elapsedSec = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r  ✔ [Storage: ${bucketName}] Found ${totalFiles.toLocaleString()} file(s), ${formatBytes(totalBytes)} in ${elapsedSec.toFixed(2)}s\n`);

        return {
            bucketName,
            status: 'OK',
            totalFiles,
            totalBytes,
            folderBreakdown,
            duration: elapsedSec
        };
    } catch (err) {
        clearInterval(timerInterval);
        process.stdout.write(`\r  ✖ [Storage: ${bucketName}] DRY-RUN FAILED: ${err.message}\n`);
        return {
            bucketName,
            status: 'ERROR',
            error: err.message,
            duration: (Date.now() - startTime) / 1000
        };
    }
}

// Memory-safe stream backup for a Firestore collection into a JSON file
async function streamBackupCollection(colRef, targetJsonPath, stats) {
    const writeStream = fs.createWriteStream(targetJsonPath, { flags: 'w', encoding: 'utf8' });
    writeStream.write('{\n');

    let isFirstDoc = true;
    let colDocCount = 0;

    await new Promise((resolve, reject) => {
        const stream = colRef.stream();

        stream.on('data', (docSnapshot) => {
            colDocCount++;
            stats.totalDocuments++;

            const docData = serializeFirestoreData(docSnapshot.data());
            const docRecord = {
                _id: docSnapshot.id,
                _createTime: docSnapshot.createTime ? docSnapshot.createTime.toDate().toISOString() : null,
                _updateTime: docSnapshot.updateTime ? docSnapshot.updateTime.toDate().toISOString() : null,
                data: docData
            };

            const jsonSnippet = (isFirstDoc ? '' : ',\n') + `  ${JSON.stringify(docSnapshot.id)}: ${JSON.stringify(docRecord, null, 2).replace(/\n/g, '\n  ')}`;
            isFirstDoc = false;

            if (!writeStream.write(jsonSnippet)) {
                stream.pause();
                writeStream.once('drain', () => stream.resume());
            }
        });

        stream.on('end', () => {
            writeStream.write('\n}\n');
            writeStream.end();
            resolve();
        });

        stream.on('error', (err) => {
            writeStream.end();
            reject(err);
        });

        writeStream.on('error', (err) => {
            reject(err);
        });
    });

    return colDocCount;
}

// Backup a single Firestore database instance
async function backupFirestoreDatabase(app, dbId, baseBackupDir) {
    const dbLabel = dbId === '(default)' ? '(default)' : dbId;
    const cleanDirName = dbId.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');
    const sessionDir = path.join(baseBackupDir, "firestore", cleanDirName, `backup_${timestamp}`);
    const latestSymlinkDir = path.join(baseBackupDir, "firestore", cleanDirName, "latest");

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(latestSymlinkDir, { recursive: true });

    const firestoreInstance = (dbId === '(default)' || !dbId) 
        ? getFirestore(app) 
        : getFirestore(app, dbId);

    const stats = { collectionsCount: 0, totalDocuments: 0, totalBytes: 0 };
    const startTime = Date.now();
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;
    let currentCollectionName = '';

    const timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
        const formatted = formatElapsedTime(elapsedSec);
        const colInfo = currentCollectionName ? ` [Col: ${currentCollectionName}]` : '';
        process.stdout.write(`\r  ${frame} [Firestore: ${dbLabel}]${colInfo} Backing up... (${stats.totalDocuments.toLocaleString()} docs) [Elapsed: ${formatted}]`);
    }, 100);

    try {
        const collections = await firestoreInstance.listCollections();
        stats.collectionsCount = collections.length;

        const manifest = {
            databaseId: dbId,
            timestamp: now.toISOString(),
            collections: []
        };

        for (const col of collections) {
            currentCollectionName = col.id;
            const colFileName = `${col.id}.json`;
            const colFilePath = path.join(sessionDir, colFileName);
            const latestColFilePath = path.join(latestSymlinkDir, colFileName);

            const docCount = await streamBackupCollection(col, colFilePath, stats);
            fs.copyFileSync(colFilePath, latestColFilePath);

            const fileStat = fs.statSync(colFilePath);
            stats.totalBytes += fileStat.size;

            manifest.collections.push({
                collection: col.id,
                documents: docCount,
                file: colFileName,
                sizeBytes: fileStat.size,
                sizeFormatted: formatBytes(fileStat.size)
            });
        }

        clearInterval(timerInterval);
        currentCollectionName = '';
        const elapsedSec = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r  ✔ [Firestore: ${dbLabel}] Exported ${stats.collectionsCount} collection(s), ${stats.totalDocuments.toLocaleString()} doc(s) in ${elapsedSec.toFixed(2)}s\n`);

        manifest.totalDocuments = stats.totalDocuments;
        manifest.totalSizeBytes = stats.totalBytes;
        manifest.totalSizeFormatted = formatBytes(stats.totalBytes);
        manifest.totalDurationSeconds = elapsedSec;

        const manifestPath = path.join(sessionDir, "_metadata.json");
        const latestManifestPath = path.join(latestSymlinkDir, "_metadata.json");
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        fs.writeFileSync(latestManifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        return {
            databaseId: `Firestore: ${dbLabel}`,
            status: 'SUCCESS',
            collections: stats.collectionsCount,
            documents: stats.totalDocuments,
            size: stats.totalBytes,
            duration: elapsedSec,
            dirPath: sessionDir
        };
    } catch (err) {
        clearInterval(timerInterval);
        process.stdout.write(`\r  ✖ [Firestore: ${dbLabel}] FAILED: ${err.message}\n`);
        return {
            databaseId: `Firestore: ${dbLabel}`,
            status: 'FAILED',
            error: err.message,
            duration: (Date.now() - startTime) / 1000
        };
    }
}

// Memory-safe incremental streaming backup for Firebase Storage
async function backupFirebaseStorage(app, baseBackupDir, prefix = '') {
    const bucketName = getStorageBucketName();
    const storageDir = path.join(baseBackupDir, "storage", "files");
    const metaDir = path.join(baseBackupDir, "storage");

    fs.mkdirSync(storageDir, { recursive: true });

    const storage = getStorage(app);
    const bucket = storage.bucket(bucketName);

    const startTime = Date.now();
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;
    let currentFileName = '';
    let processedFiles = 0;
    let downloadedBytes = 0;
    let skippedFiles = 0;
    let totalBytesSeen = 0;

    const timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
        const formatted = formatElapsedTime(elapsedSec);
        const fileInfo = currentFileName ? ` [${path.basename(currentFileName).substring(0, 20)}]` : '';
        process.stdout.write(`\r  ${frame} [Storage]${fileInfo} (${processedFiles.toLocaleString()} files, ${formatBytes(downloadedBytes)}) [Elapsed: ${formatted}]`);
    }, 100);

    try {
        const manifest = {
            bucket: bucketName,
            timestamp: new Date().toISOString(),
            prefix: prefix || null,
            totalFiles: 0,
            skippedFiles: 0,
            downloadedBytes: 0
        };

        await new Promise((resolve, reject) => {
            const streamOptions = prefix ? { prefix } : {};
            const fileStream = bucket.getFilesStream(streamOptions);

            // Queue processing to avoid overwhelming disk / network
            let isPaused = false;
            const queue = [];
            let activeDownloads = 0;
            const CONCURRENCY = 4;

            async function processNext() {
                if (queue.length === 0) {
                    if (isPaused) {
                        isPaused = false;
                        fileStream.resume();
                    }
                    return;
                }

                while (queue.length > 0 && activeDownloads < CONCURRENCY) {
                    const file = queue.shift();
                    activeDownloads++;

                    (async () => {
                        try {
                            currentFileName = file.name;
                            const targetFilePath = path.join(storageDir, file.name);
                            const targetDirPath = path.dirname(targetFilePath);

                            if (!fs.existsSync(targetDirPath)) {
                                fs.mkdirSync(targetDirPath, { recursive: true });
                            }

                            const expectedSize = parseInt(file.metadata ? file.metadata.size || '0' : '0', 10);
                            totalBytesSeen += expectedSize;
                            let needsDownload = true;

                            if (fs.existsSync(targetFilePath)) {
                                const localStat = fs.statSync(targetFilePath);
                                if (localStat.size === expectedSize) {
                                    needsDownload = false;
                                    skippedFiles++;
                                }
                            }

                            if (needsDownload) {
                                await file.download({ destination: targetFilePath });
                                downloadedBytes += expectedSize;
                            }

                            processedFiles++;
                        } catch (downloadErr) {
                            console.error(`\n  [!] Error downloading ${file.name}: ${downloadErr.message}`);
                        } finally {
                            activeDownloads--;
                            processNext();
                        }
                    })();
                }
            }

            fileStream.on('data', (file) => {
                queue.push(file);
                if (queue.length >= 50 && !isPaused) {
                    isPaused = true;
                    fileStream.pause();
                }
                processNext();
            });

            fileStream.on('end', async () => {
                // Wait for all remaining queue items to finish
                const checkInterval = setInterval(() => {
                    if (queue.length === 0 && activeDownloads === 0) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });

            fileStream.on('error', (err) => {
                reject(err);
            });
        });

        clearInterval(timerInterval);
        currentFileName = '';
        const elapsedSec = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r  ✔ [Storage: ${bucketName}] Processed ${processedFiles.toLocaleString()} file(s) (${skippedFiles.toLocaleString()} unchanged, ${(processedFiles - skippedFiles).toLocaleString()} downloaded) in ${elapsedSec.toFixed(2)}s\n`);

        manifest.totalFiles = processedFiles;
        manifest.skippedFiles = skippedFiles;
        manifest.downloadedBytes = downloadedBytes;
        manifest.totalBytes = totalBytesSeen;
        manifest.durationSeconds = elapsedSec;
        fs.writeFileSync(path.join(metaDir, "_metadata.json"), JSON.stringify(manifest, null, 2), 'utf8');

        return {
            databaseId: "Firebase Storage",
            status: "SUCCESS",
            collections: 1,
            documents: processedFiles,
            size: downloadedBytes,
            duration: elapsedSec,
            dirPath: storageDir
        };
    } catch (err) {
        clearInterval(timerInterval);
        process.stdout.write(`\r  ✖ [Storage: ${bucketName}] FAILED: ${err.message}\n`);
        return {
            databaseId: "Firebase Storage",
            status: "FAILED",
            error: err.message,
            duration: (Date.now() - startTime) / 1000
        };
    }
}

// Backup Realtime Database (RTDB)
async function backupRealtimeDatabase(app, baseBackupDir) {
    const rtdbBackupDir = path.join(baseBackupDir, "rtdb");
    if (!fs.existsSync(rtdbBackupDir)) {
        fs.mkdirSync(rtdbBackupDir, { recursive: true });
    }

    const db = admin.database();
    const dbPath = process.env.DB_PATH || "/";
    const startTime = Date.now();
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;

    const timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
        const formatted = formatElapsedTime(elapsedSec);
        process.stdout.write(`\r  ${frame} [RTDB: ${dbPath}] Downloading snapshot... [Elapsed: ${formatted}]`);
    }, 100);

    try {
        const ref = db.ref(dbPath);
        const snapshot = await ref.once("value");
        clearInterval(timerInterval);

        const elapsedSec = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r  ✔ [RTDB: ${dbPath}] Downloaded in ${elapsedSec.toFixed(2)}s\n`);

        const data = snapshot.val();
        const now = new Date();
        const timestamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');
        const filename = `backup_${timestamp}.json`;
        const filePath = path.join(rtdbBackupDir, filename);
        const latestFilePath = path.join(rtdbBackupDir, "backup_latest.json");

        const jsonContent = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, jsonContent, "utf8");
        fs.writeFileSync(latestFilePath, jsonContent, "utf8");

        const fileStats = fs.statSync(filePath);
        const keyCount = (data && typeof data === 'object') ? Object.keys(data).length : (data !== null ? 1 : 0);

        return {
            databaseId: "Realtime Database",
            status: "SUCCESS",
            collections: 1,
            documents: keyCount,
            size: fileStats.size,
            duration: elapsedSec,
            dirPath: filePath
        };
    } catch (err) {
        clearInterval(timerInterval);
        process.stdout.write(`\r  ✖ [RTDB] FAILED: ${err.message}\n`);
        return {
            databaseId: "Realtime Database",
            status: "FAILED",
            error: err.message,
            duration: (Date.now() - startTime) / 1000
        };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const isDryRun = args.includes("--dry-run") || args.includes("-d") || process.env.DRY_RUN === "true";

    console.log("==================================================================");
    if (isDryRun) {
        console.log("    FIREBASE, FIRESTORE & STORAGE BACKUP TOOL  [🔍 DRY-RUN MODE]  ");
    } else {
        console.log("         AUTOMATED FIREBASE, FIRESTORE & STORAGE BACKUP TOOL      ");
    }
    console.log("==================================================================");

    const serviceAccountPath = getServiceAccount();
    console.log(`[+] Service Account: ${path.basename(serviceAccountPath)}`);

    const serviceAccount = require(serviceAccountPath);
    const dbUrl = process.env.DB_URL || 
                  process.env.DATABASE_URL || 
                  "https://adil-app-dd510-default-rtdb.asia-southeast1.firebasedatabase.app";
    const storageBucket = getStorageBucketName();

    const app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl,
        storageBucket: storageBucket
    });

    const baseBackupDir = path.join(__dirname, "backups");

    // Parse target selections from CLI
    let targetFirestoreDbs = [];
    const dbArg = args.find(a => a.startsWith("--db="));
    const prefixArg = args.find(a => a.startsWith("--prefix=") || a.startsWith("--folder="));
    const prefix = prefixArg ? prefixArg.split("=")[1].trim() : '';

    const backupType = args.find(a => a.startsWith("--type="));
    const isRtdbOnly = args.includes("--rtdb") || backupType === "--type=rtdb";
    const isStorageOnly = args.includes("--storage") || backupType === "--type=storage";
    const isFirestoreOnly = args.includes("--firestore") || backupType === "--type=firestore";
    const isAll = args.includes("--all") || backupType === "--type=all";

    if (dbArg) {
        targetFirestoreDbs = [dbArg.split("=")[1].trim()];
    } else if (process.env.FIRESTORE_DATABASES) {
        targetFirestoreDbs = process.env.FIRESTORE_DATABASES.split(",").map(s => s.trim()).filter(Boolean);
    } else {
        targetFirestoreDbs = ["(default)", "pemilihan", "perwakilan", "staging", "voting"];
    }

    const overallStartTime = Date.now();

    // ==========================================
    // DRY RUN EXECUTION
    // ==========================================
    if (isDryRun) {
        const dryResults = [];
        
        // Dry-run Firestore
        if (!isRtdbOnly && !isStorageOnly) {
            console.log(`\n[🔍 DRY-RUN] Inspecting ${targetFirestoreDbs.length} Firestore Database(s): [${targetFirestoreDbs.join(", ")}]`);
            for (const dbId of targetFirestoreDbs) {
                const res = await dryRunFirestoreDatabase(app, dbId);
                dryResults.push({ type: 'firestore', ...res });
            }
        }

        // Dry-run Storage
        let storageDryResult = null;
        if (!isFirestoreOnly && !isRtdbOnly && (isStorageOnly || isAll || !dbArg)) {
            console.log(`\n[🔍 DRY-RUN] Streaming inspection for Firebase Storage Bucket: "${storageBucket}"${prefix ? ` (Prefix: ${prefix})` : ''}`);
            storageDryResult = await dryRunStorage(app, prefix);
        }

        const totalDuration = (Date.now() - overallStartTime) / 1000;

        console.log("\n==================================================================");
        console.log("                       DRY-RUN INSPECTION REPORT                  ");
        console.log("==================================================================");

        let totalEstimatedDocs = 0;
        let totalCols = 0;

        for (const r of dryResults) {
            if (r.status === 'OK') {
                totalCols += r.collectionsCount;
                totalEstimatedDocs += r.documentsCount;
                console.log(`\n✔ Firestore DB: [${r.databaseId}] (Scan Time: ${r.duration.toFixed(2)}s)`);
                console.log(`  ├─ Total Collections : ${r.collectionsCount}`);
                console.log(`  ├─ Total Documents   : ~${r.documentsCount.toLocaleString()}`);
                if (r.collections && r.collections.length > 0) {
                    console.log(`  └─ Top Collections:`);
                    const sorted = [...r.collections].sort((a,b) => b.count - a.count);
                    sorted.slice(0, 8).forEach((c, idx) => {
                        const isLast = idx === Math.min(sorted.length, 8) - 1;
                        console.log(`     ${isLast ? '└' : '├'}─ ${c.name.padEnd(25)} : ~${c.count.toLocaleString()} doc(s)`);
                    });
                    if (sorted.length > 8) {
                        console.log(`     └─ ... (+${sorted.length - 8} more collections)`);
                    }
                }
            } else {
                console.log(`\n✖ Firestore DB: [${r.databaseId}] | ERROR: ${r.error}`);
            }
        }

        if (storageDryResult) {
            if (storageDryResult.status === 'OK') {
                console.log(`\n✔ Firebase Storage Bucket: [${storageDryResult.bucketName}] (Scan Time: ${storageDryResult.duration.toFixed(2)}s)`);
                console.log(`  ├─ Total Files       : ${storageDryResult.totalFiles.toLocaleString()}`);
                console.log(`  ├─ Total Size        : ${formatBytes(storageDryResult.totalBytes)}`);
                console.log(`  └─ Folder Breakdown  :`);
                const folders = Object.entries(storageDryResult.folderBreakdown);
                folders.forEach(([folder, info], idx) => {
                    const isLast = idx === folders.length - 1;
                    console.log(`     ${isLast ? '└' : '├'}─ ${folder.padEnd(25)} : ${info.count.toLocaleString()} file(s) (${formatBytes(info.bytes)})`);
                });
            } else {
                console.log(`\n✖ Firebase Storage: [${storageDryResult.bucketName}] | ERROR: ${storageDryResult.error}`);
            }
        }

        console.log("\n------------------------------------------------------------------");
        console.log(` Total Dry-Run Time  : ${formatElapsedTime(totalDuration)}`);
        console.log(` Notice              : Dry-run complete. Run 'npm run backup' for actual backup.`);
        console.log("==================================================================\n");

        try { await admin.app().delete(); } catch (e) {}
        return;
    }

    // ==========================================
    // ACTUAL BACKUP EXECUTION
    // ==========================================
    const results = [];

    // Firestore Backups
    if (!isRtdbOnly && !isStorageOnly) {
        console.log(`\n[+] Backing up ${targetFirestoreDbs.length} Firestore Database(s): [${targetFirestoreDbs.join(", ")}]`);
        for (const dbId of targetFirestoreDbs) {
            console.log(`\n-> Starting Firestore database: "${dbId}"`);
            const res = await backupFirestoreDatabase(app, dbId, baseBackupDir);
            results.push(res);
        }
    }

    // Storage Backup
    if (isStorageOnly || isAll) {
        console.log(`\n-> Starting Firebase Storage backup: "${storageBucket}"...`);
        const res = await backupFirebaseStorage(app, baseBackupDir, prefix);
        results.push(res);
    }

    // Realtime Database Backup
    if (isRtdbOnly || isAll) {
        console.log(`\n-> Starting Firebase Realtime Database...`);
        const res = await backupRealtimeDatabase(app, baseBackupDir);
        results.push(res);
    }

    const totalDuration = (Date.now() - overallStartTime) / 1000;

    // Print Master Summary Table
    console.log("\n==================================================================");
    console.log("                        BACKUP SUMMARY REPORT                     ");
    console.log("==================================================================");
    
    let totalSize = 0;
    let totalDocs = 0;
    let totalCols = 0;
    let successCount = 0;

    for (const r of results) {
        if (r.status === 'SUCCESS') {
            successCount++;
            totalSize += r.size;
            totalDocs += r.documents;
            totalCols += r.collections;
            console.log(`✔ [${r.databaseId.padEnd(20)}] | Items/Docs: ${String(r.documents).padStart(8)} | Size: ${formatBytes(r.size).padStart(10)} | Time: ${r.duration.toFixed(2)}s`);
        } else {
            console.log(`✖ [${r.databaseId.padEnd(20)}] | ERROR: ${r.error}`);
        }
    }

    console.log("------------------------------------------------------------------");
    console.log(` Services Processed  : ${results.length} (${successCount} succeeded, ${results.length - successCount} failed)`);
    console.log(` Total Backup Size   : ${formatBytes(totalSize)}`);
    console.log(` Total Elapsed Time  : ${formatElapsedTime(totalDuration)}`);
    console.log(` Backup Location     : ${baseBackupDir}`);
    console.log("==================================================================\n");

    try {
        await admin.app().delete();
    } catch (e) {
        // ignore
    }
}

main().catch(err => {
    console.error("\nFatal error during backup:", err);
    process.exit(1);
});
