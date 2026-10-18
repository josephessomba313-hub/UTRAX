import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

// 20 connexions simultanées à la base (10 avant). La file d'attente est PLAFONNÉE : au-delà, la requête
// échoue tout de suite (« Queue limit reached », transformée en 503 par index.js) au lieu d'attendre
// indéfiniment et de faire s'écrouler le serveur en cas de forte affluence.
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 150,
  connectTimeout: 10000,
})
