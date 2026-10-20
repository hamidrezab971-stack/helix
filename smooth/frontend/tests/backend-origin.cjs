const port = process.env.HELIX_QA_BACKEND_PORT || '8000'
if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) throw new Error('Invalid isolated backend port')
module.exports = { port: +port, origin: `http://127.0.0.1:${port}` }
