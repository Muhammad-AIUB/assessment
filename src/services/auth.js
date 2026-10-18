import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 7;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, keyHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

export async function login(pool, username, password) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active', [username]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) throw unauthorized('Wrong username or password');
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [token, user.id]);
  return { token, user: publicUser(user) };
}

export async function logout(pool, token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function userForToken(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.active`, [token]);
  return rows[0] ? publicUser(rows[0]) : null;
}

export const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active });

// ---- staff management (owner only; enforced at the route) ----

export async function listUsers(pool) {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY role, name');
  return rows.map(publicUser);
}

export async function createUser(pool, { name, username, password, role = 'staff' }) {
  if (!name?.trim() || !username?.trim()) throw badRequest('Name and username are required');
  if (!password || password.length < 6) throw badRequest('Password must be at least 6 characters');
  if (!['owner', 'staff'].includes(role)) throw badRequest('Invalid role');
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), username.trim().toLowerCase(), await hashPassword(password), role]);
    return publicUser(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw conflict('Username already taken');
    throw e;
  }
}

export async function setUserActive(pool, id, active, actingUserId) {
  if (Number(id) === actingUserId && !active) throw badRequest('You cannot deactivate yourself');
  const { rows } = await pool.query('UPDATE users SET active = $2 WHERE id = $1 RETURNING *', [id, !!active]);
  if (!rows[0]) throw notFound('User not found');
  if (!active) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  return publicUser(rows[0]);
}
