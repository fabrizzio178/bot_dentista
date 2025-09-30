// index.js  (usa "type": "module" en package.json)
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import Database from 'better-sqlite3';
import schedule from 'node-schedule';
import { DateTime } from 'luxon';

const TOKEN = process.env.TELEGRAM_TOKEN;
const TZ = process.env.BOT_TIMEZONE || 'America/Argentina/Buenos_Aires';
if (!TOKEN) {
  console.error('Falta TELEGRAM_TOKEN en .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Database('turnos.db');

// Tabla de turnos
db.prepare(`
  CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    fecha_iso TEXT NOT NULL,
    descripcion TEXT,
    created_at TEXT NOT NULL
  )
`).run();

// Helpers DB
function agregarTurno(chatId, fechaISO, descripcion) {
  const stmt = db.prepare(
    'INSERT INTO turnos (chat_id, fecha_iso, descripcion, created_at) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(chatId, fechaISO, descripcion || '', new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function listarTurnos(chatId) {
  return db.prepare(
    `SELECT * FROM turnos WHERE chat_id = ? AND datetime(fecha_iso) >= datetime('now') ORDER BY fecha_iso`
  ).all(chatId);
}

function borrarTurno(id, chatId) {
  return db.prepare('DELETE FROM turnos WHERE id = ? AND chat_id = ?').run(id, chatId).changes > 0;
}

// Scheduler
const jobsMap = new Map();

const REMINDERS = [
  { key: '24h', label: '1 día', minus: { days: 1 } },
  { key: '10h', label: '10 horas', minus: { hours: 10 } },
  { key: '2h', label: '2 horas', minus: { hours: 2 } },
  { key: '1h', label: '1 hora', minus: { hours: 1 } },
  { key: '30m', label: '30 minutos', minus: { minutes: 30 } },
];

function scheduleRemindersForTurno(turno) {
  const dtUtc = DateTime.fromISO(turno.fecha_iso, { zone: 'utc' });
  for (const r of REMINDERS) {
    const when = dtUtc.minus(r.minus);
    if (when <= DateTime.utc()) continue;
    const key = `turno-${turno.id}-${r.key}`;
    if (jobsMap.has(key)) jobsMap.get(key).cancel();

    const job = schedule.scheduleJob(when.toJSDate(), () => {
      const localFmt = dtUtc.setZone(TZ).toFormat('dd/LL/yyyy HH:mm');
      bot.sendMessage(
        turno.chat_id,
        `⏰ Recordatorio (${r.label} antes): ${localFmt} ${turno.descripcion || ''}`
      );
      jobsMap.delete(key);
    });
    jobsMap.set(key, job);
  }
}

// Reprogramar al iniciar
(function init() {
  const futuros = db.prepare(
    "SELECT * FROM turnos WHERE datetime(fecha_iso) > datetime('now')"
  ).all();
  futuros.forEach(scheduleRemindersForTurno);
  console.log(`Programados ${futuros.length} turnos futuros`);
})();

// ----- Inline Calendar -----
function calendarKeyboard(startDate, days = 37) { // 30 + 7
  const start = DateTime.fromISO(startDate, { zone: TZ });
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = start.plus({ days: i });
    const weekIndex = Math.floor(i / 7);
    if (!rows[weekIndex]) rows[weekIndex] = [];
    rows[weekIndex].push({
      text: d.toFormat('dd/MM'),
      callback_data: `pickDay_${d.toISODate()}`
    });
  }
  return { reply_markup: { inline_keyboard: rows } };
}

// Vamos a tener muchos horarios → los dividimos en filas
function hoursKeyboard(dateISO) {
  // Ejemplo: cada 30 min de 07:00 a 19:00
  const hours = [];
  for (let h = 7; h <= 19; h++) {
    hours.push(`${h.toString().padStart(2, '0')}:00`);
    hours.push(`${h.toString().padStart(2, '0')}:30`);
  }

  // Telegram limita 100 botones, los repartimos de a 4 por fila
  const rows = [];
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(
      hours.slice(i, i + 4).map(h => ({
        text: h,
        callback_data: `pickHour_${dateISO}_${h}`
      }))
    );
  }

  return { reply_markup: { inline_keyboard: rows } };
}

// ----- Bot commands -----
bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Hola! Soy tu recordatorio de turnos.\nComandos:\n` +
    `/turno → agenda un turno con selector\n` +
    `/turnos → listar turnos\n` +
    `/borrar ID → borrar turno por ID`
  );
});

bot.onText(/^\/turnos$/, (msg) => {
  const rows = listarTurnos(msg.chat.id);
  if (rows.length === 0) return bot.sendMessage(msg.chat.id, 'No hay turnos agendados.');
  const list = rows.map(r => {
    const dt = DateTime.fromISO(r.fecha_iso, { zone: 'utc' }).setZone(TZ)
      .toFormat('dd/LL/yyyy HH:mm');
    return `${r.id}. ${dt} — ${r.descripcion || 'Sin descripción'}`;
  }).join('\n');
  bot.sendMessage(msg.chat.id, list);
});

bot.onText(/^\/borrar (\d+)$/, (msg, match) => {
  const id = Number(match[1]);
  if (borrarTurno(id, msg.chat.id)) {
    bot.sendMessage(msg.chat.id, `🗑️ Turno ${id} borrado`);
  } else {
    bot.sendMessage(msg.chat.id, `No se encontró el turno ${id}`);
  }
});

// Comando para nuevo turno (antes era /nuevo, ahora /turno)
bot.onText(/^\/turno$/, (msg) => {
  const today = DateTime.now().setZone(TZ).toISODate();
  bot.sendMessage(msg.chat.id, '📅 Elegí el día del turno:', calendarKeyboard(today, 37));
});

// Callback de inline keyboards
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('pickDay_')) {
    const dateISO = data.replace('pickDay_', '');
    bot.editMessageText(
      `📅 Día elegido: ${DateTime.fromISO(dateISO).toFormat('dd/LL/yyyy')}\n⏰ Elegí la hora:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        ...hoursKeyboard(dateISO)
      }
    );
  }

  if (data.startsWith('pickHour_')) {
    const [, dateISO, hourStr] = data.split('_');
    const dt = DateTime.fromISO(`${dateISO}T${hourStr}`, { zone: TZ });
    const fechaISO_utc = dt.toUTC().toISO();

    const id = agregarTurno(chatId, fechaISO_utc, 'Turno');
    scheduleRemindersForTurno({ id, chat_id: chatId, fecha_iso: fechaISO_utc, descripcion: 'Turno' });

    bot.editMessageText(
      `✅ Turno agendado (ID ${id}) para ${dt.toFormat('dd/LL/yyyy HH:mm')}`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }
});

console.log('Bot iniciado...');
