import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import os from 'os';
import http from 'http'; // Ditambahkan untuk mencegah Railway "Stopping Container"

// Import Commands (Sistem Modular Sederhana)
import handleAiCommand from './src/commands/ai.js';
import handleStickerCommand from './src/commands/sticker.js';

const logger = pino({ level: 'silent' }); 

// ==========================================
// KEEPALIVE SERVER (MENCEGAH RAILWAY STOPPING CONTAINER)
// ==========================================
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Bot is Alive and Running!\n');
});
server.listen(port, () => {
    console.log(`🌐 Keep-Alive Server berjalan di port ${port}`);
});
// ==========================================

// ==========================================
// ANTI-CRASH HANDLER (Diperkuat - Membungkam Semua Spam Error)
// ==========================================
process.on('uncaughtException', function (err) {
    let e = String(err);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE') || e.includes('decrypt message') || e.includes('Session error') || e.includes('Connection Closed') || e.includes('Precondition Required')) return;
    console.log('Caught exception: ', err);
});

process.on('unhandledRejection', function (reason, p) {
    let e = String(reason);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE') || e.includes('decrypt message') || e.includes('Session error') || e.includes('Connection Closed') || e.includes('Precondition Required')) return;
    if (e !== 'undefined') console.log('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});
// ==========================================

// ==========================================
// PENGATURAN BOT & JADWAL
// ==========================================
const phoneNumber = "6285256739684"; 
const usePairingCode = true;
const botStartTime = new Date(); // Mencatat waktu script dijalankan

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; // File database jadwal
let botSchedules = [];

// Buat folder session jika belum ada
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

// Load schedules jika file sudah ada
if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}

// Fungsi untuk menyimpan perubahan jadwal
function saveSchedules() {
    fs.writeFileSync(schedulesFile, JSON.stringify(botSchedules, null, 2));
}

// ==========================================
// FUNGSI PENTING: AUTO-DELETE SESSION (LOGOUT MANUAL)
// ==========================================
function clearZombieSession() {
    console.log('\n⚠️ MENGHAPUS SESI LAMA YANG LOGOUT/KORUP...');
    if (fs.existsSync(sessionPath)) {
        fs.readdirSync(sessionPath).forEach(file => {
            // Hapus file KECUALI schedules agar data jadwal tidak hilang
            if (file !== 'schedules.json') {
                try { fs.unlinkSync(`${sessionPath}/${file}`); } catch (e) {}
            }
        });
        console.log('✅ Data sesi lama berhasil dibersihkan! Memulai ulang sistem...\n');
    }
}

// ==========================================
// Helper Format Waktu & Tanggal
// ==========================================
function formatWITA(dateObj) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Makassar',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true
    }).format(dateObj);
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60);
    const h = Math.floor(seconds / 3600);
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} days ago`;
    if (h > 0) return `${h} hours ago`;
    if (m > 0) return `${m} minutes ago`;
    return `${Math.floor(seconds)} seconds ago`;
}
// ==========================================

let schedulerInterval; // Variabel penampung loop jadwal

async function connectToWhatsApp() {
    console.log('🔄 Memulai koneksi ke WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`📡 Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: !usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'), 
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
            return { conversation: 'Bot is running' };
        }
    });

    let pairingCodeRequested = false; // Flag mencegah spam request kode

    // ==========================================
    // EVENT: CONNECTION UPDATE (TERMASUK REQUEST PAIRING CODE)
    // ==========================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // FOOLPROOF FIX: Hanya minta kode HANYA JIKA socket sudah matang dan mengirim QR
        if (qr && usePairingCode && !sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true; // Tandai agar tidak request ganda
            try {
                // Jeda 1.5 detik ekstra untuk memastikan server WhatsApp siap 100%
                setTimeout(async () => {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n====================================================`);
                    console.log(`🔑 KODE PAIRING ANDA: ${code}`);
                    console.log(`====================================================`);
                    console.log(`Cara Login:`);
                    console.log(`1. Buka WhatsApp di HP Anda (Nomor Bot).`);
                    console.log(`2. Ketuk ikon titik tiga (Opsi lainnya) > Perangkat Tertaut.`);
                    console.log(`3. Ketuk 'Tautkan Perangkat'.`);
                    console.log(`4. Pilih 'Tautkan dengan nomor telepon saja'.`);
                    console.log(`5. Masukkan kode 8 digit di atas.`);
                    console.log(`====================================================\n`);
                }, 1500);
            } catch (err) {
                console.error('❌ Gagal meminta kode pairing:', err);
                pairingCodeRequested = false; // Reset jika gagal agar bisa mengulang
            }
        }

        if (connection === 'close') {
            pairingCodeRequested = false; // Reset flag saat putus
            
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Koneksi terputus. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('❌ Perangkat telah dikeluarkan (Logged Out) secara manual.');
                clearZombieSession();
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    });

    // ==========================================
    // SISTEM AUTO-SEND JADWAL (Interval Loop)
    // ==========================================
    if (schedulerInterval) clearInterval(schedulerInterval);
    schedulerInterval = setInterval(async () => {
        const now = Date.now();
        let hasChanges = false;
        
        for (let i = 0; i < botSchedules.length; i++) {
            const jadwal = botSchedules[i];
            // Cek apakah waktu saat ini sudah melewati waktu jadwal WITA yang ditentukan
            if (jadwal.status === 'pending' && now >= jadwal.timestamp) {
                try {
                    console.log(`[SCHEDULE] Mengirim pesan terjadwal ke ${jadwal.target}`);
                    await sock.sendMessage(jadwal.target, { text: jadwal.pesan });
                    jadwal.status = 'sent';
                    hasChanges = true;
                } catch (err) {
                    console.error(`[SCHEDULE] Gagal mengirim pesan ke ${jadwal.target}`, err);
                    jadwal.status = 'failed'; 
                    hasChanges = true;
                }
            }
        }
        
        if (hasChanges) {
            // Hapus yang sudah terkirim (sent) atau error (failed) agar file database bersih
            botSchedules = botSchedules.filter(s => s.status === 'pending');
            saveSchedules();
        }
    }, 30000); // Mengecek jadwal setiap 30 detik

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // EVENT: COMMAND HANDLER (PESAN MASUK)
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || '';

            const prefix = '!';
            if (!text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const sender = msg.key.remoteJid;

            console.log(`[COMMAND] ${command} dari ${sender}`);

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                                     `* !menu* - Menampilkan menu ini\n` +
                                     `* !jadwalranap* - Cek jadwal pasien rawat inap\n` +
                                     `* !ai <teks>* - Tanya AI\n` +
                                     `* !sticker* - Buat stiker\n` +
                                     `* !ping* - Cek status bot\n` +
                                     `* !runtime* - Cek info sistem & server\n` +
                                     `* !tagall* - Tag semua member grup\n\n` +
                                     `*🗓️ Jadwal Otomatis (Auto-Send):*\n` +
                                     `* !addjadwal* - Tambah jadwal pesan baru\n` +
                                     `* !listjadwal* - Lihat antrean pesan terjadwal\n` +
                                     `* !deljadwal <id>* - Hapus pesan terjadwal`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                // ==========================================
                // FITUR BARU: GET DATA JADWAL RANAP (DARI VERCEL API)
                // ==========================================
                case 'jadwalranap':
                    await sock.sendMessage(sender, { text: '⏳ _Sedang mengambil data jadwal rawat inap dari server..._' }, { quoted: msg });
                    
                    try {
                        // Melakukan Fetch ke API Vercel Anda
                        const response = await fetch('https://ishiprsud.vercel.app/api/jadwal');
                        const result = await response.json();

                        if (!result.status || result.data.length === 0) {
                            const errMsgs = result.message || '📭 *Tidak ada data jadwal pasien rawat inap saat ini.*';
                            await sock.sendMessage(sender, { text: errMsgs }, { quoted: msg });
                            break;
                        }

                        // Format Balasan Pesan WA
                        let replyTxt = `🏥 *MANIFEST PASIEN RAWAT INAP*\n\n`;
                        replyTxt += `📊 *Total Pasien:* ${result.total_data}\n`;
                        replyTxt += `⏱️ *Update Terakhir:* ${result.last_updated || 'Terbaru'}\n\n`;

                        result.data.forEach((p, i) => {
                            replyTxt += `*${i + 1}. ${p.nama_pasien}*\n`;
                            replyTxt += ` 🛏️ Ruang: ${p.ruangan} (${p.no_kamar})\n`;
                            replyTxt += ` 🆔 RM: ${p.no_rm} | Usia: ${p.usia}\n`;
                            replyTxt += ` 👨‍⚕️ DPJP: ${p.dpjp_utama}\n`;
                            if (p.dokter_rawat_bersama !== '-') {
                                replyTxt += ` 👨‍⚕️ Bersama: ${p.dokter_rawat_bersama}\n`;
                            }
                            replyTxt += ` 🗓️ Masuk: ${p.tanggal_masuk}\n`;
                            replyTxt += ` ⏳ Lama Rawat: ${p.lama_rawat}\n\n`;
                        });

                        replyTxt += `_Data disinkronkan otomatis dari Ekstensi Chrome._`;

                        await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });

                    } catch (error) {
                        console.error('Error fetching jadwal ranap API:', error);
                        await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel.*\nPastikan Ekstensi Auto-Scrape di PC sedang berjalan.' }, { quoted: msg });
                    }
                    break;

                // --- FITUR AUTO SCHEDULE MESSAGE ---
                case 'addjadwal':
                    const jadwalArgs = args.join(' ').split('|').map(s => s.trim());
                    
                    if (jadwalArgs.length < 3) {
                        const panduan = `⚠️ *Format Pembuatan Jadwal Salah!*\n\n` +
                                        `Gunakan pemisah tanda palang ( | ) antara waktu, nomor tujuan, dan pesannya.\n\n` +
                                        `*Format:*\n!addjadwal DD-MM-YYYY HH:mm | Nomor/GrupID | Pesan\n\n` +
                                        `*Contoh untuk nomor:* \n!addjadwal 01-05-2026 10:30 | 6281234567890 | Halo bos!\n\n` +
                                        `*Contoh untuk grup:* \n!addjadwal 01-05-2026 14:00 | 123456-123456@g.us | Info rapat guys!`;
                        await sock.sendMessage(sender, { text: panduan }, { quoted: msg });
                        break;
                    }

                    const [waktuInput, targetInput, ...pesanArr] = jadwalArgs;
                    const pesanTeks = pesanArr.join(' | ');
                    
                    const waktuSplit = waktuInput.split(' ');
                    if (waktuSplit.length !== 2) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Salah!*\n\nHarus persis seperti ini: DD-MM-YYYY HH:mm\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    const [tgl, bln, thn] = waktuSplit[0].split('-');
                    const jamMnt = waktuSplit[1];

                    if (!tgl || !bln || !thn || !jamMnt) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Salah!*\n\nHarus persis seperti ini: DD-MM-YYYY HH:mm\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    const isoString = `${thn}-${bln}-${tgl}T${jamMnt}:00+08:00`;
                    const timestampWITA = Date.parse(isoString);

                    if (isNaN(timestampWITA)) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Tidak Valid!*\n\nPastikan angka tanggal dan jam benar.\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    let finalTarget = targetInput;
                    if (!finalTarget.includes('@')) {
                        finalTarget = finalTarget.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    }

                    const jadwalId = Math.floor(Math.random() * 900000 + 100000).toString(); 
                    const newJadwal = {
                        id: jadwalId,
                        waktu: waktuInput,
                        timestamp: timestampWITA,
                        target: finalTarget,
                        pesan: pesanTeks,
                        status: 'pending'
                    };

                    botSchedules.push(newJadwal);
                    saveSchedules();

                    const suksesMsg = `✅ *Jadwal Berhasil Ditambahkan!*\n\n` +
                                      `🔖 *ID:* ${newJadwal.id}\n` +
                                      `⏰ *Waktu:* ${newJadwal.waktu} WITA\n` +
                                      `🎯 *Tujuan:* ${targetInput}\n` +
                                      `💬 *Pesan:* ${newJadwal.pesan.substring(0, 50)}${newJadwal.pesan.length > 50 ? '...' : ''}`;
                    await sock.sendMessage(sender, { text: suksesMsg }, { quoted: msg });
                    break;

                case 'listjadwal':
                    const pendingSchedules = botSchedules.filter(s => s.status === 'pending');
                    
                    if (pendingSchedules.length === 0) {
                        await sock.sendMessage(sender, { text: '📭 *Tidak ada jadwal antrean pesan yang aktif saat ini.*' }, { quoted: msg });
                        break;
                    }

                    let listTxt = `🗓️ *DAFTAR ANTREAN JADWAL*\n\n`;
                    pendingSchedules.forEach((j, i) => {
                        listTxt += `*${i+1}. [ID: ${j.id}]*\n` +
                                   ` ⏰ ${j.waktu} WITA\n` +
                                   ` 🎯 Ke: ${j.target.split('@')[0]}\n` +
                                   ` 💬 Psn: ${j.pesan.substring(0, 30)}...\n\n`;
                    });
                    listTxt += `_Ketik !deljadwal <ID> untuk membatalkan pesan._`;
                    
                    await sock.sendMessage(sender, { text: listTxt }, { quoted: msg });
                    break;

                case 'deljadwal':
                    if (!args[0]) {
                        await sock.sendMessage(sender, { text: '⚠️ *Masukkan ID jadwal yang mau dibatalkan/dihapus.*\nContoh: !deljadwal 123456' }, { quoted: msg });
                        break;
                    }
                    
                    const hapusId = args[0];
                    const idx = botSchedules.findIndex(s => s.id === hapusId);
                    
                    if (idx !== -1) {
                        botSchedules.splice(idx, 1);
                        saveSchedules();
                        await sock.sendMessage(sender, { text: `🗑️ *Jadwal dengan ID ${hapusId} berhasil dibatalkan dan dihapus!*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `❌ *Jadwal dengan ID ${hapusId} tidak ditemukan di antrean.*` }, { quoted: msg });
                    }
                    break;
                // --------------------------

                case 'ping':
                    const messageTime = msg.messageTimestamp * 1000;
                    const pingSpeed = Date.now() - messageTime;
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingSpeed} ms` }, { quoted: msg });
                    break;

                case 'runtime':
                    const uptimeSec = process.uptime();
                    const rHours = Math.floor(uptimeSec / 3600).toString().padStart(2, '0');
                    const rMinutes = Math.floor((uptimeSec % 3600) / 60).toString().padStart(2, '0');
                    const rSeconds = Math.floor(uptimeSec % 60).toString().padStart(2, '0');
                    
                    const formattedUptime = `${rHours}:${rMinutes}:${rSeconds}`;
                    const relativeText = getRelativeTime(uptimeSec);
                    const startTimeString = formatWITA(botStartTime);

                    const memUsage = process.memoryUsage();
                    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);
                    const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);

                    const osType = os.type();
                    const osRelease = os.release();
                    const osPlatform = os.platform();
                    const osArch = os.arch();
                    const cpus = os.cpus();
                    const cpuModel = cpus[0]?.model.trim() || 'Unknown CPU';
                    const cpuSpeed = cpus[0]?.speed || 0;
                    const totalRamGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                    const freeRamGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);

                    let groupCount = 0;
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        groupCount = Object.keys(groups).length;
                    } catch (e) {
                        groupCount = 'Error';
                    }

                    const runtimeReply = `⏱️ *Runtime Bot*\n` +
                                         `• Uptime      : ${formattedUptime} (sejak ${relativeText})\n` +
                                         `• Start Time  : ${startTimeString} WITA\n` +
                                         `• Guilds      : ${groupCount}\n` +
                                         `• Node.js     : ${process.version}\n` +
                                         `• Memory (RSS): ${rssMB} MB\n` +
                                         `• Heap Used   : ${heapMB} MB\n\n` +
                                         `🖥️ *Spesifikasi Core VPS*\n` +
                                         `• OS          : ${osType} ${osRelease} (${osPlatform}/${osArch})\n` +
                                         `• CPU         : ${cpuModel}\n` +
                                         `• CPU Cores   : ${cpus.length} cores @ ${cpuSpeed} MHz\n` +
                                         `• RAM (Total) : ${totalRamGB} GB\n` +
                                         `• RAM (Free)  : ${freeRamGB} GB`;

                    await sock.sendMessage(sender, { text: runtimeReply }, { quoted: msg });
                    break;

                case 'ai':
                    await handleAiCommand(sock, msg, args);
                    break;

                case 'sticker':
                case 's':
                    await handleStickerCommand(sock, msg);
                    break;

                case 'tagall':
                    if (!sender.endsWith('@g.us')) return;
                    const groupMetadata = await sock.groupMetadata(sender);
                    const tagParticipants = groupMetadata.participants.map(p => p.id);
                    let mentionText = `*📢 PERHATIAN SEMUA 📢*\n\n`;
                    tagParticipants.forEach(p => mentionText += `👉 @${p.split('@')[0]}\n`);
                    await sock.sendMessage(sender, { text: mentionText, mentions: tagParticipants }, { quoted: msg });
                    break;
            }
        } catch (error) {
            console.error('Error saat memproses pesan:', error);
        }
    });
}

connectToWhatsApp();
