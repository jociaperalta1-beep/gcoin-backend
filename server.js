const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = 4000;

app.use(express.json());
app.use(cors());

// Conexión a la base de datos SQLite
const db = new sqlite3.Database('./gcoin_guarani.db', (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.message);
  } else {
    console.log('Conectado a la base de datos SQLite de Gcoin Guaraní.');
  }
});

// Ruta de prueba en la raíz
app.get('/', (req, res) => {
  res.send('<h1>¡Bienvenido a Gcoin Guaraní! Servidor DePIN activo.</h1>');
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('Servidor de Gcoin Guarani corriendo en el puerto 4000');
});