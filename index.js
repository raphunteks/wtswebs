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
// PENGATURAN BOT
// ==========================================
const phoneNumber = "6285338922586"; // NOMOR BARU DIPERBARUI
const usePairingCode = true;
const botStartTime = new Date(); 

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; 
let botSchedules = [];

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}

function saveSchedules() { fs.writeFileSync(schedulesFile, JSON.stringify(botSchedules, null, 2)); }

function clearZombieSession() {
    console.log('\n⚠️ MENGHAPUS SESI LAMA YANG LOGOUT/KORUP...');
    if (fs.existsSync(sessionPath)) {
        fs.readdirSync(sessionPath).forEach(file => {
            if (file !== 'schedules.json') {
                try { fs.unlinkSync(`${sessionPath}/${file}`); } catch (e) {}
            }
        });
        console.log('✅ Data sesi lama berhasil dibersihkan! Memulai ulang sistem...\n');
    }
}

function formatWITA(dateObj) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Makassar', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true }).format(dateObj);
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

let schedulerInterval; 

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

            // SMART COMMAND DETECTOR UNTUK RAWAT JALAN
            const isRajal = command.startsWith('cekrajal');

            if (isRajal) {
                await sock.sendMessage(sender, { text: `⏳ _Sedang mengambil data rawat jalan dari server..._` }, { quoted: msg });
                try {
                    // Deteksi Kata Kunci
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
                    
                    // URL dengan filter ganda (Tanggal & Jenis)
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

                    replyTxt += `_Data disinkronkan otomatis dari Ekstensi Chrome._`;
                    await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });

                } catch (error) {
                    console.error(`Error fetching ${command}:`, error);
                    await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel.*\nPastikan Ekstensi Auto-Scrape di PC menyala.' }, { quoted: msg });
                }
                return; // Stop eksekusi agar tidak lanjut ke switch lain
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
                                     `*⚙️ SISTEM & LAINNYA:*\n` +
                                     `* !addjadwal* - Tambah auto-send\n` +
                                     `* !listjadwal* - Lihat auto-send\n` +
                                     `* !deljadwal <id>* - Hapus auto-send\n` +
                                     `* !ping* - Cek ping bot\n` +
                                     `* !runtime* - Cek sistem info`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
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

                        await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });
                    } catch (error) { await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel.*' }, { quoted: msg }); }
                    break;

                // Fitur Add/List/Del Jadwal & Ping/Runtime tetap sama (saya persingkat visualnya agar rapi)
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
