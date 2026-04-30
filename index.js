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
// ANTI-CRASH HANDLER (Diperkuat)
// ==========================================
process.on('uncaughtException', function (err) {
    let e = String(err);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE')) return;
    console.log('Caught exception: ', err);
});

process.on('unhandledRejection', function (reason, p) {
    let e = String(reason);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE')) return;
    console.log('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});
// ==========================================

// ==========================================
// PENGATURAN BOT & SISTEM SETTING
// ==========================================
const phoneNumber = "6285338922586"; 
const usePairingCode = true;
const botStartTime = new Date(); // Mencatat waktu script dijalankan

const sessionPath = './session';
const settingsFile = `${sessionPath}/settings.json`;
let botSettings = { welcome: true, leave: true };

// Buat folder session jika belum ada
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

// Load setting jika file sudah ada
if (fs.existsSync(settingsFile)) {
    try {
        botSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch (e) {
        console.error('Gagal membaca settings.json, menggunakan default.');
    }
}

// Fungsi untuk menyimpan perubahan setting
function saveSettings() {
    fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2));
}

// ==========================================
// FUNGSI PENTING: AUTO-DELETE SESSION (LOGOUT MANUAL)
// ==========================================
function clearZombieSession() {
    console.log('\n⚠️ MENGHAPUS SESI LAMA YANG LOGOUT/KORUP...');
    if (fs.existsSync(sessionPath)) {
        fs.readdirSync(sessionPath).forEach(file => {
            // Hapus semua file KECUALI settings.json agar pengaturan Welcome/Leave tidak hilang
            if (file !== 'settings.json') {
                try {
                    fs.unlinkSync(`${sessionPath}/${file}`);
                } catch (e) {}
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

    if (usePairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
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
            } catch (err) {
                console.error('Gagal meminta kode pairing. Sesi mungkin bentrok.', err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            // Deteksi Status Code dari Disconnect
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Koneksi terputus. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // JEDA 3 DETIK (Mencegah Crash Loop)
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                // JIKA TERDETEKSI LOGOUT MANUAL (Status 401 / loggedOut)
                console.log('❌ Perangkat telah dikeluarkan (Logged Out) secara manual.');
                clearZombieSession();
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // EVENT: WELCOME & LEAVE MESSAGE
    // ==========================================
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        
        try {
            const groupMetadata = await sock.groupMetadata(id);
            const groupName = groupMetadata.subject;

            for (const participant of participants) {
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(participant, 'image');
                } catch {
                    ppUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Default_pfp.svg/1200px-Default_pfp.svg.png';
                }

                // Cek status setting sebelum mengirim Welcome
                if (action === 'add' && botSettings.welcome) {
                    const welcomeText = `Halo @${participant.split('@')[0]}! 👋\n\nSelamat datang di grup *${groupName}*.\nJangan lupa perkenalkan diri dan baca deskripsi grup ya!`;
                    await sock.sendMessage(id, { image: { url: ppUrl }, caption: welcomeText, mentions: [participant] });
                } 
                // Cek status setting sebelum mengirim Leave
                else if (action === 'remove' && botSettings.leave) {
                    const leaveText = `Selamat tinggal @${participant.split('@')[0]} 👋\n\nSemoga sukses selalu di luar sana.`;
                    await sock.sendMessage(id, { image: { url: ppUrl }, caption: leaveText, mentions: [participant] });
                }
            }
        } catch (error) {
            console.error('Error pada Welcome/Leave handler:', error);
        }
    });

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
                                     `* !setting* - Lihat status fitur bot\n` +
                                     `* !ai <teks>* - Tanya AI\n` +
                                     `* !sticker* - Buat stiker\n` +
                                     `* !ping* - Cek status bot\n` +
                                     `* !runtime* - Cek info sistem & server\n` +
                                     `* !tagall* - Tag semua member grup\n\n` +
                                     `*⚙️ Pengaturan Admin:*\n` +
                                     `* !welcome on/off* - Atur pesan selamat datang\n` +
                                     `* !leave on/off* - Atur pesan keluar`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                // --- PENGATURAN FITUR ---
                case 'setting':
                case 'settings':
                    const settingText = `⚙️ *PENGATURAN BOT*\n\n` +
                                        `👋 Welcome Msg : ${botSettings.welcome ? '✅ ON' : '❌ OFF'}\n` +
                                        `🚪 Leave Msg   : ${botSettings.leave ? '✅ ON' : '❌ OFF'}\n\n` +
                                        `_Ketik !welcome off atau !leave off untuk mematikan._`;
                    await sock.sendMessage(sender, { text: settingText }, { quoted: msg });
                    break;

                case 'welcome':
                    if (args[0] === 'on') {
                        botSettings.welcome = true; saveSettings();
                        await sock.sendMessage(sender, { text: '✅ Fitur Welcome Message berhasil DIAKTIFKAN!' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.welcome = false; saveSettings();
                        await sock.sendMessage(sender, { text: '❌ Fitur Welcome Message telah DINONAKTIFKAN!' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!welcome on* atau *!welcome off*' }, { quoted: msg });
                    }
                    break;

                case 'leave':
                    if (args[0] === 'on') {
                        botSettings.leave = true; saveSettings();
                        await sock.sendMessage(sender, { text: '✅ Fitur Leave Message berhasil DIAKTIFKAN!' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.leave = false; saveSettings();
                        await sock.sendMessage(sender, { text: '❌ Fitur Leave Message telah DINONAKTIFKAN!' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!leave on* atau *!leave off*' }, { quoted: msg });
                    }
                    break;
                // --------------------------

                case 'ping':
                    const messageTime = msg.messageTimestamp * 1000;
                    const pingSpeed = Date.now() - messageTime;
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingSpeed} ms` }, { quoted: msg });
                    break;

                case 'runtime':
                    // Kalkulasi Uptime
                    const uptimeSec = process.uptime();
                    const rHours = Math.floor(uptimeSec / 3600).toString().padStart(2, '0');
                    const rMinutes = Math.floor((uptimeSec % 3600) / 60).toString().padStart(2, '0');
                    const rSeconds = Math.floor(uptimeSec % 60).toString().padStart(2, '0');
                    
                    const formattedUptime = `${rHours}:${rMinutes}:${rSeconds}`;
                    const relativeText = getRelativeTime(uptimeSec);
                    const startTimeString = formatWITA(botStartTime);

                    // Memori & Spek
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

                    // Hitung jumlah Grup
                    let groupCount = 0;
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        groupCount = Object.keys(groups).length;
                    } catch (e) {
                        groupCount = 'Error';
                    }

                    // Format Pesan (Sesuai Gambar User)
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