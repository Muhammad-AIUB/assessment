import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { text, oneOf } from '../validate.js';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 7;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, keyHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

// A real hash to verify against when the username doesn't exist, so "no such user" takes as long
// as "wrong password" and response timing doesn't reveal which usernames exist.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

/** Sessions are looked up by SHA-256 of the cookie value; the raw token is never stored. */
const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export async function login(pool, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 40 || password.length > 128) {
    throw unauthorized('Wrong username or password');
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active', [username.trim().toLowerCase()]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Wrong username or password');
  const token = randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at < now()'); // housekeeping
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [tokenHash(token), user.id, SESSION_DAYS]);
  return { token, user: publicUser(user) };
}

export async function logout(pool, token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function userForToken(pool, token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [tokenHash(token)]);
  return rows[0] ? publicUser(rows[0]) : null;
}

export const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active });

// ---- staff management (owner only; enforced at the route) ----

export async function listUsers(pool) {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY role, name');
  return rows.map(publicUser);
}

export async function createUser(pool, { name, username, password, role = 'staff' } = {}) {
  name = text(name, 'Name', { max: 80 });
  username = text(username, 'Username', { max: 40, min: 3 }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) throw badRequest('Username can use letters, numbers, dot, dash and underscore');
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw badRequest('Password must be 6 to 128 characters');
  oneOf(role, 'Role', ['owner', 'staff']);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, username, await hashPassword(password), role]);
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
