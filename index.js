import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import os from 'os';
import http from 'http'; 

import handleAiCommand from './src/commands/ai.js';
import handleStickerCommand from './src/commands/sticker.js';

const logger = pino({ level: 'silent' }); 

const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Bot is Alive and Running!\n');
});
server.listen(port, () => console.log(`🌐 Keep-Alive Server berjalan di port ${port}`));

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
// PENGATURAN BOT & AUTO INFO
// ==========================================
const phoneNumber = "6285338922586"; 
const usePairingCode = true;
const botStartTime = new Date(); 

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; 
const settingsFile = `${sessionPath}/settings.json`; 

let botSchedules = [];
// Pengaturan target grup untuk Auto Info
let botSettings = { autoRanap: [], autoRajal: [] };

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

// Memuat Jadwal
if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}
// Memuat Pengaturan (Untuk Auto Info Grup)
if (fs.existsSync(settingsFile)) {
    try { 
        const loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); 
        botSettings = { ...botSettings, ...loaded };
    } catch (e) { }
}

function saveSchedules() { fs.writeFileSync(schedulesFile, JSON.stringify(botSchedules, null, 2)); }
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2)); }

function clearZombieSession() {
    console.log('\n⚠️ MENGHAPUS SESI LAMA YANG LOGOUT/KORUP...');
    if (fs.existsSync(sessionPath)) {
        fs.readdirSync(sessionPath).forEach(file => {
            // Jangan hapus data jadwal dan setting
            if (file !== 'schedules.json' && file !== 'settings.json') {
                try { fs.unlinkSync(`${sessionPath}/${file}`); } catch (e) {}
            }
        });
        console.log('✅ Data sesi lama berhasil dibersihkan! Memulai ulang sistem...\n');
    }
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
// SMART DIFF ALGORITHM (Mendeteksi Perubahan Data)
// ==========================================
let lastRanapData = null;
let lastRajalEndoData = null;
let lastRajalBMData = null;

function getDifferences(oldList, newList) {
    const makeKey = (p) => `${p.no_rm}_${p.nama_pasien}`;
    const oldMap = new Map(oldList.map(p => [makeKey(p), p]));
    const newMap = new Map(newList.map(p => [makeKey(p), p]));
    
    const added = newList.filter(p => !oldMap.has(makeKey(p)));
    const removed = oldList.filter(p => !newMap.has(makeKey(p)));
    
    return { added, removed };
}

async function checkApiUpdates(sock) {
    try {
        // 1. Cek Auto Info RAWAT INAP
        if (botSettings.autoRanap.length > 0) {
            const resRanap = await fetch('https://ishiprsud.vercel.app/api/jadwalranap');
            const dataRanap = await resRanap.json();
            
            if (dataRanap.status) {
                const currentRanap = dataRanap.data || [];
                
                // Pastikan bukan tarikan pertama saat bot baru nyala (agar tidak spam)
                if (lastRanapData !== null) {
                    const { added, removed } = getDifferences(lastRanapData, currentRanap);
                    
                    if (added.length > 0 || removed.length > 0) {
                        let msg = `🏥 *AUTO INFO: RAWAT INAP*\n_Mendeteksi perubahan data manifest._\n\n`;
                        
                        if (added.length > 0) {
                            msg += `🟢 *PASIEN MASUK/BARU (${added.length}):*\n`;
                            added.forEach((p, i) => msg += ` ${i+1}. ${p.nama_pasien} (RM: ${p.no_rm})\n    🛏️ ${p.ruangan}\n`);
                            msg += `\n`;
                        }
                        if (removed.length > 0) {
                            msg += `🔴 *PASIEN KELUAR/PULANG (${removed.length}):*\n`;
                            removed.forEach((p, i) => msg += ` ${i+1}. ${p.nama_pasien} (RM: ${p.no_rm})\n    🛏️ ${p.ruangan}\n`);
                            msg += `\n`;
                        }
                        msg += `📊 *Total Saat Ini:* ${currentRanap.length} Pasien`;
                        
                        // Kirim ke semua grup yang menyalakan fitur ini
                        for (const jid of botSettings.autoRanap) {
                            await sock.sendMessage(jid, { text: msg });
                        }
                    }
                }
                lastRanapData = currentRanap;
            }
        }

        // 2. Cek Auto Info RAWAT JALAN (Hari Ini)
        if (botSettings.autoRajal.length > 0) {
            const targetDate = new Date();
            const dateWITA = targetDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 

            const resEndo = await fetch(`https://ishiprsud.vercel.app/api/jadwalrajalendo?tanggal=${dateWITA}`);
            const dataEndo = await resEndo.json();
            const currentEndo = dataEndo.status ? (dataEndo.data || []) : [];

            const resBM = await fetch(`https://ishiprsud.vercel.app/api/jadwalrajalbm?tanggal=${dateWITA}`);
            const dataBM = await resBM.json();
            const currentBM = dataBM.status ? (dataBM.data || []) : [];

            // Pastikan bukan tarikan pertama
            if (lastRajalEndoData !== null && lastRajalBMData !== null) {
                const diffEndo = getDifferences(lastRajalEndoData, currentEndo);
                const diffBM = getDifferences(lastRajalBMData, currentBM);

                const hasEndoDiff = diffEndo.added.length > 0 || diffEndo.removed.length > 0;
                const hasBMDiff = diffBM.added.length > 0 || diffBM.removed.length > 0;

                if (hasEndoDiff || hasBMDiff) {
                    let msg = `🏥 *AUTO INFO: RAWAT JALAN*\n_Perubahan antrean tanggal ${dateWITA}._\n\n`;

                    if (hasEndoDiff) {
                        msg += `🦷 *Klinik Endodonsi:*\n`;
                        if (diffEndo.added.length > 0) msg += ` 🟢 Tambah: ${diffEndo.added.map(p => p.nama_pasien).join(', ')}\n`;
                        if (diffEndo.removed.length > 0) msg += ` 🔴 Selesai/Batal: ${diffEndo.removed.map(p => p.nama_pasien).join(', ')}\n`;
                        msg += `\n`;
                    }

                    if (hasBMDiff) {
                        msg += `💉 *Klinik Bedah Mulut:*\n`;
                        if (diffBM.added.length > 0) msg += ` 🟢 Tambah: ${diffBM.added.map(p => p.nama_pasien).join(', ')}\n`;
                        if (diffBM.removed.length > 0) msg += ` 🔴 Selesai/Batal: ${diffBM.removed.map(p => p.nama_pasien).join(', ')}\n`;
                        msg += `\n`;
                    }

                    msg += `📊 *Total Antrean (Hari Ini):* Endo (${currentEndo.length}), BM (${currentBM.length})`;

                    for (const jid of botSettings.autoRajal) {
                        await sock.sendMessage(jid, { text: msg });
                    }
                }
            }
            lastRajalEndoData = currentEndo;
            lastRajalBMData = currentBM;
        }

    } catch (e) {
        // Abaikan jika server Vercel sedang timeout agar bot tidak crash
    }
}

// ==========================================

let schedulerInterval; 
let autoInfoInterval;

async function connectToWhatsApp() {
    console.log('🔄 Memulai koneksi ke WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, logger, printQRInTerminal: !usePairingCode,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger), },
        browser: Browsers.ubuntu('Chrome'), 
        generateHighQualityLinkPreview: true, syncFullHistory: false, markOnlineOnConnect: true,
        getMessage: async (key) => ({ conversation: 'Bot is running' })
    });

    let pairingCodeRequested = false; 

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && usePairingCode && !sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true; 
            try {
                setTimeout(async () => {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔑 KODE PAIRING ANDA: ${code}\n`);
                }, 1500);
            } catch (err) {
                console.error('❌ Gagal meminta kode pairing:', err);
                pairingCodeRequested = false; 
            }
        }

        if (connection === 'close') {
            pairingCodeRequested = false; 
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
            else { clearZombieSession(); setTimeout(() => connectToWhatsApp(), 3000); }
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    });

    // Scheduler Broadcast
    if (schedulerInterval) clearInterval(schedulerInterval);
    schedulerInterval = setInterval(async () => {
        const now = Date.now();
        let hasChanges = false;
        for (let i = 0; i < botSchedules.length; i++) {
            const jadwal = botSchedules[i];
            if (jadwal.status === 'pending' && now >= jadwal.timestamp) {
                try {
                    await sock.sendMessage(jadwal.target, { text: jadwal.pesan });
                    jadwal.status = 'sent'; hasChanges = true;
                } catch (err) { jadwal.status = 'failed'; hasChanges = true; }
            }
        }
        if (hasChanges) {
            botSchedules = botSchedules.filter(s => s.status === 'pending');
            saveSchedules();
        }
    }, 30000); 

    // Auto Info API Checker (Tiap 60 Detik)
    if (autoInfoInterval) clearInterval(autoInfoInterval);
    autoInfoInterval = setInterval(() => checkApiUpdates(sock), 60000);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
            const prefix = '!';
            if (!text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const sender = msg.key.remoteJid;

            console.log(`[COMMAND] ${command} dari ${sender}`);

            const isRajal = command.startsWith('cekrajal');

            if (isRajal) {
                await sock.sendMessage(sender, { text: `⏳ _Sedang mengambil data rawat jalan dari server..._` }, { quoted: msg });
                try {
                    const isEndo = command.includes('endo');
                    const isRiwayat = command.includes('riwayat');
                    const isAntrian = command.includes('antrianpx');
                    const isBesok = command.endsWith('bsk');

                    const endpointName = isEndo ? 'jadwalrajalendo' : 'jadwalrajalbm';
                    const jenisScrape = isRiwayat ? 'riwayat' : (isAntrian ? 'antrian' : '');
                    const namaPoli = isEndo ? 'ENDODONSI' : 'BEDAH MULUT';
                    const namaJenis = isRiwayat ? 'Riwayat Antrian' : 'Antrian Pasien';
                    
                    let targetDate = new Date();
                    if (isBesok) targetDate.setDate(targetDate.getDate() + 1);
                    const dateWITA = targetDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
                    
                    const response = await fetch(`https://ishiprsud.vercel.app/api/${endpointName}?tanggal=${dateWITA}&jenis=${jenisScrape}`);
                    const result = await response.json();

                    if (!result.status || result.data.length === 0) {
                        await sock.sendMessage(sender, { text: `📭 *Tidak ada data ${namaJenis} ${namaPoli} untuk tanggal ${dateWITA}.*` }, { quoted: msg });
                        return;
                    }

                    let replyTxt = `🏥 *${namaJenis.toUpperCase()} (${namaPoli})*\n📅 *Tanggal Kunjungan:* ${dateWITA}\n\n`;
                    replyTxt += `📊 *Total Pasien:* ${result.total_data}\n`;
                    replyTxt += `⏱️ *Update Terakhir:* ${result.last_updated || 'Terbaru'}\n\n`;

                    result.data.forEach((p, i) => {
                        replyTxt += `*${i + 1}. ${p.nama_pasien}*\n`;
                        replyTxt += ` 🆔 RM: ${p.no_rm}\n`;
                        replyTxt += ` ⏰ Kunjungan: ${p.tanggal_kunjungan}\n`;
                        replyTxt += ` 👨‍⚕️ Dokter: ${p.dokter}\n`;
                        replyTxt += ` 🏷️ Penjamin: ${p.penjamin}\n`;
                        replyTxt += ` 📌 Status: ${p.status}\n\n`;
                    });

                    replyTxt += `*_Data disinkronkan otomatis dari Web RSUD Kendari._*`;
                    await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });

                } catch (error) {
                    console.error(`Error fetching ${command}:`, error);
                    await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel.*\nPastikan Ekstensi Auto-Scrape di PC menyala.' }, { quoted: msg });
                }
                return; 
            }

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                                     `*🏥 DAFTAR PERINTAH KLINIK:*\n` +
                                     `* !jadwalranap* - Cek pasien Rawat Inap\n\n` +
                                     `*(HARI INI)*\n` +
                                     `* !cekrajalriwayatendo*\n` +
                                     `* !cekrajalrantrianpxendo*\n` +
                                     `* !cekrajalriwayatbm*\n` +
                                     `* !cekrajalrantrianpxbm*\n\n` +
                                     `*(BESOK)*\n` +
                                     `* !cekrajalriwayatendobsk*\n` +
                                     `* !cekrajalrantrianpxendobsk*\n` +
                                     `* !cekrajalriwayatbmbsk*\n` +
                                     `* !cekrajalrantrianpxbmbsk*\n\n` +
                                     `*🔔 AUTO INFO (GROUP/CHAT):*\n` +
                                     `* !autoranap on/off* - Notif Otomatis Ranap\n` +
                                     `* !autorajal on/off* - Notif Otomatis Rajal\n\n` +
                                     `*⚙️ SISTEM & LAINNYA:*\n` +
                                     `* !refresh* - 🔄 Paksa Ekstensi Scrape!\n` +
                                     `* !addjadwal* - Tambah auto-send\n` +
                                     `* !listjadwal* - Lihat auto-send\n` +
                                     `* !deljadwal <id>* - Hapus auto-send\n` +
                                     `* !ping* - Cek ping bot\n` +
                                     `* !runtime* - Cek sistem info`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                // ==========================================
                // FITUR AUTO INFO TOGGLE
                // ==========================================
                case 'autoranap':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRanap.includes(sender)) botSettings.autoRanap.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Inap AKTIF* di obrolan ini.\nBot akan otomatis mengirim pesan laporan jika mendeteksi ada pasien yang masuk atau keluar (pulang).' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.autoRanap = botSettings.autoRanap.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Inap NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoranap on* atau *!autoranap off*' }, { quoted: msg });
                    }
                    break;

                case 'autorajal':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRajal.includes(sender)) botSettings.autoRajal.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Jalan AKTIF* di obrolan ini.\nBot akan otomatis mengirim laporan ke obrolan ini setiap kali antrean Endo/BM bertambah atau berkurang pada hari ini.' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.autoRajal = botSettings.autoRajal.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Jalan NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autorajal on* atau *!autorajal off*' }, { quoted: msg });
                    }
                    break;

                case 'refresh':
                    await sock.sendMessage(sender, { text: '⏳ _Mengirim sinyal refresh ke Ekstensi Chrome..._' }, { quoted: msg });
                    try {
                        await fetch('https://ishiprsud.vercel.app/api/trigger', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refresh: true })
                        });
                        await sock.sendMessage(sender, { text: '✅ *Sinyal terkirim!*\n\nEkstensi Chrome di PC Anda akan mendeteksinya dalam waktu 20 detik dan langsung melakukan tarikan data baru.' }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(sender, { text: '❌ *Gagal mengirim sinyal ke Vercel.*' }, { quoted: msg });
                    }
                    break;

                case 'jadwalranap':
                    await sock.sendMessage(sender, { text: '⏳ _Sedang mengambil data jadwal rawat inap dari server..._' }, { quoted: msg });
                    try {
                        const response = await fetch('https://ishiprsud.vercel.app/api/jadwalranap');
                        const result = await response.json();

                        if (!result.status || result.data.length === 0) {
                            await sock.sendMessage(sender, { text: result.message || '📭 *Tidak ada data jadwal pasien rawat inap saat ini.*' }, { quoted: msg });
                            break;
                        }

                        let replyTxt = `🏥 *MANIFEST PASIEN RAWAT INAP*\n\n📊 *Total Pasien:* ${result.total_data}\n⏱️ *Update Terakhir:* ${result.last_updated || 'Terbaru'}\n\n`;

                        result.data.forEach((p, i) => {
                            replyTxt += `*${i + 1}. ${p.nama_pasien}*\n 🛏️ Ruang: ${p.ruangan} (${p.no_kamar})\n 🆔 RM: ${p.no_rm} | Usia: ${p.usia}\n 👨‍⚕️ DPJP: ${p.dpjp_utama}\n`;
                            if (p.dokter_rawat_bersama !== '-') replyTxt += ` 👨‍⚕️ Bersama: ${p.dokter_rawat_bersama}\n`;
                            replyTxt += ` 🗓️ Masuk: ${p.tanggal_masuk}\n ⏳ Lama Rawat: ${p.lama_rawat}\n\n`;
                        });

                        replyTxt += `*_Data disinkronkan otomatis dari Web RSUD Kendari._*`;
                        await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });
                    } catch (error) { await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel.*' }, { quoted: msg }); }
                    break;

                case 'ping':
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${Date.now() - (msg.messageTimestamp * 1000)} ms` }, { quoted: msg });
                    break;

                case 'ai':
                    await handleAiCommand(sock, msg, args);
                    break;

                case 'sticker':
                case 's':
                    await handleStickerCommand(sock, msg);
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}
connectToWhatsApp();
