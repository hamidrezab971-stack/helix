const net = require('node:net')

// Never accept a readiness response from a pre-existing local service.
module.exports = async function assertPortFree(port) {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new Error(`Isolated tests require free loopback port ${port}: ${error.code}. No existing service was contacted or stopped.`)))
    probe.listen(port, '127.0.0.1', resolve)
  })
  await new Promise(resolve => probe.close(resolve))
}
