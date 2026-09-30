const mineflayer = require('mineflayer')
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js')
const http = require('http')
require('dotenv').config()

// ─── Config ────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CLIENT_ID     = process.env.CLIENT_ID
const GUILD_ID      = process.env.GUILD_ID
const CHANNEL_ID    = process.env.CHANNEL_ID
const OWNER_ID      = process.env.OWNER_ID
const MC_HOST       = process.env.MC_HOST
const MC_PORT       = parseInt(process.env.MC_PORT || '25565')
const MC_VERSION    = process.env.MC_VERSION || '1.20.1'
const MAX_BOTS      = parseInt(process.env.MAX_BOTS || '10')

// ─── Validate ──────────────────────────────────────────────────────────────
const required = { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, CHANNEL_ID, OWNER_ID, MC_HOST }
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`[ERROR] Missing env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// ─── Keep Railway alive ────────────────────────────────────────────────────
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000)

// ─── Username Pool ─────────────────────────────────────────────────────────
const USERNAME_POOL = [
  'ShadowRelay', 'GhostBridge', 'NullWatcher', 'VoidLink', 'EchoNode',
  'DarkPulse',   'IronCloak',   'StealthNet',  'PhantomX', 'CipherOne',
  'NightCrawl',  'ByteShift',   'GlitchCore',  'ZeroTrace','SilentDrop'
]

function pickUsername() {
  const taken = new Set([...bots.keys()])
  const available = USERNAME_POOL.filter(u => !taken.has(u))
  if (available.length === 0) return `Bot_${Date.now().toString(36)}`
  return available[Math.floor(Math.random() * available.length)]
}

// ─── Bot Store ─────────────────────────────────────────────────────────────
// Map<username, { mc, reconnectTimer, reconnectDelay, active }>
const bots = new Map()

// ─── BungeeCord (optional) ─────────────────────────────────────────────────
let bungeecord = null
try {
  bungeecord = require('mineflayer-bungeecord')
  console.log('[MC] BungeeCord plugin loaded')
} catch (e) {
  console.warn('[MC] BungeeCord plugin not found — connecting without it')
}

// ─── Slash Commands ────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('addbot').setDescription('Spawn a new bot on the MC server (owner only)')
    .addIntegerOption(o => o.setName('count').setDescription('How many bots to add (default 1, max 10)').setRequired(false)),

  new SlashCommandBuilder().setName('removebot').setDescription('Disconnect a specific bot (owner only)')
    .addStringOption(o => o.setName('username').setDescription('Bot username to remove').setRequired(true)),

  new SlashCommandBuilder().setName('removeall').setDescription('Disconnect all bots (owner only)'),

  new SlashCommandBuilder().setName('listbots').setDescription('List all active bots'),

  new SlashCommandBuilder().setName('say').setDescription('Send chat message from all bots (or one specific bot)')
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
    .addStringOption(o => o.setName('bot').setDescription('Specific bot username (optional)').setRequired(false)),

  new SlashCommandBuilder().setName('players').setDescription('List online players'),

  new SlashCommandBuilder().setName('pos').setDescription('Show a bot position')
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('health').setDescription('Show a bot health and food')
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('jump').setDescription('Make a bot jump (owner only)')
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('walk').setDescription('Move a bot (owner only)')
    .addStringOption(o => o.setName('direction').setDescription('Direction').setRequired(true)
      .addChoices(
        { name: 'Forward', value: 'forward' },
        { name: 'Back',    value: 'back'    },
        { name: 'Left',    value: 'left'    },
        { name: 'Right',   value: 'right'   }
      ))
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in ms (default 2000)').setRequired(false))
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('stop').setDescription('Stop all movement on a bot (owner only)')
    .addStringOption(o => o.setName('bot').setDescription('Bot username — omit for all bots').setRequired(false)),

  new SlashCommandBuilder().setName('follow').setDescription('Follow a player (owner only)')
    .addStringOption(o => o.setName('username').setDescription('Player to follow').setRequired(true))
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('look').setDescription('Look at a player')
    .addStringOption(o => o.setName('username').setDescription('Player to look at').setRequired(true))
    .addStringOption(o => o.setName('bot').setDescription('Bot username (defaults to first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('reconnect').setDescription('Reconnect a bot (owner only)')
    .addStringOption(o => o.setName('bot').setDescription('Bot username — omit for all bots').setRequired(false)),

  new SlashCommandBuilder().setName('help').setDescription('List all commands'),
].map(c => c.toJSON())

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
  try {
    console.log('[Discord] Registering slash commands...')
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
    console.log('[Discord] Slash commands live.')
  } catch (err) { console.error('[Discord] Failed to register commands:', err) }
}

// ─── Discord Client ────────────────────────────────────────────────────────
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})

let channel = null

function sendToDiscord(msg) { if (channel) channel.send(msg).catch(() => {}) }
function isOwner(i) { return i.user.id === OWNER_ID }

// ─── Get first active bot ──────────────────────────────────────────────────
function firstBot() {
  for (const [, entry] of bots) {
    if (entry.active && entry.mc) return entry.mc
  }
  return null
}

function getBot(username) {
  if (!username) return firstBot()
  const entry = bots.get(username)
  return entry && entry.active ? entry.mc : null
}

// ─── Create One Bot ────────────────────────────────────────────────────────
function createBot(username) {
  if (bots.has(username)) {
    const existing = bots.get(username)
    if (existing.reconnectTimer) { clearTimeout(existing.reconnectTimer); existing.reconnectTimer = null }
  }

  const entry = bots.get(username) || { mc: null, reconnectTimer: null, reconnectDelay: 15000, active: true }
  entry.active = true
  bots.set(username, entry)

  const botOptions = {
    host: MC_HOST,
    port: MC_PORT,
    username,
    version: MC_VERSION,
    auth: 'offline',
    hideErrors: false,
    checkTimeoutInterval: 30000
  }

  if (bungeecord) {
    botOptions.connect = (client) => bungeecord.connect(client, MC_HOST, MC_PORT)
  }

  const mc = mineflayer.createBot(botOptions)
  entry.mc = mc

  if (bungeecord) mc.loadPlugin(bungeecord)

  mc.on('login', () => {
    entry.reconnectDelay = 15000
    console.log(`[MC] ${username} logged in`)
    sendToDiscord(`✅ **${username}** joined \`${MC_HOST}\``)
  })

  mc.on('chat', (sender, message) => {
    if (sender === username) return
    if (channel) channel.send(`💬 **${sender}**: ${message}`).catch(() => {})
  })

  mc.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    if (!text.includes('<') && text.trim().length > 0)
      if (channel) channel.send(`📢 ${text.slice(0, 1900)}`).catch(() => {})
  })

  mc.on('kicked', (reason) => {
    console.log(`[MC] ${username} kicked: ${reason}`)
    sendToDiscord(`⚠️ **${username}** kicked: ${reason}`)
    if (entry.active) scheduleReconnect(username)
  })

  mc.on('end', (reason) => {
    console.log(`[MC] ${username} disconnected: ${reason}`)
    if (entry.active) {
      sendToDiscord(`🔴 **${username}** disconnected (${reason || 'unknown'}). Reconnecting in ${entry.reconnectDelay / 1000}s...`)
      scheduleReconnect(username)
    }
  })

  mc.on('error', (err) => {
    console.error(`[MC ERROR] ${username}: ${err.message}`)
    sendToDiscord(`❌ **${username}** error: ${err.message}`)
  })

  mc.on('death', () => { mc.respawn(); sendToDiscord(`💀 **${username}** died — respawning`) })
  mc.on('spawn', () => console.log(`[MC] ${username} spawned`))
}

function scheduleReconnect(username) {
  const entry = bots.get(username)
  if (!entry || entry.reconnectTimer) return
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null
    entry.reconnectDelay = Math.min(entry.reconnectDelay * 2, 120000)
    if (entry.active) createBot(username)
  }, entry.reconnectDelay)
}

function removeBot(username) {
  const entry = bots.get(username)
  if (!entry) return false
  entry.active = false
  if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
  if (entry.mc) {
    try { entry.mc.end() } catch (e) {}
  }
  bots.delete(username)
  return true
}

// ─── Slash Command Handler ─────────────────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.channelId !== CHANNEL_ID)
    return interaction.reply({ content: '❌ Wrong channel.', ephemeral: true })

  const { commandName } = interaction
  const ownerOnly = ['addbot','removebot','removeall','stop','reconnect','jump','walk','follow']

  if (ownerOnly.includes(commandName) && !isOwner(interaction))
    return interaction.reply({ content: '❌ Owner only.', ephemeral: true })

  switch (commandName) {

    case 'addbot': {
      const count = Math.min(interaction.options.getInteger('count') || 1, 10)
      const available = MAX_BOTS - bots.size
      if (available <= 0)
        return interaction.reply(`❌ Max bots reached (${MAX_BOTS}). Use \`/removebot\` first.`)
      const toAdd = Math.min(count, available)
      const added = []
      for (let i = 0; i < toAdd; i++) {
        const username = pickUsername()
        createBot(username)
        added.push(username)
      }
      await interaction.reply(`✅ Spawning **${added.length}** bot(s): ${added.map(u => `\`${u}\``).join(', ')}`)
      break
    }

    case 'removebot': {
      const username = interaction.options.getString('username')
      const removed = removeBot(username)
      await interaction.reply(removed ? `✅ **${username}** disconnected.` : `❌ Bot \`${username}\` not found.`)
      break
    }

    case 'removeall': {
      const names = [...bots.keys()]
      names.forEach(removeBot)
      await interaction.reply(`✅ Disconnected **${names.length}** bot(s).`)
      break
    }

    case 'listbots': {
      if (bots.size === 0) return interaction.reply('No bots connected.')
      const lines = [...bots.entries()].map(([name, entry]) =>
        `• \`${name}\` — ${entry.active ? '🟢 active' : '🔴 reconnecting'}`
      )
      const embed = new EmbedBuilder()
        .setTitle(`🤖 Active Bots (${bots.size}/${MAX_BOTS})`)
        .setColor(0x2ecc71)
        .setDescription(lines.join('\n'))
      await interaction.reply({ embeds: [embed] })
      break
    }

    case 'say': {
      const text = interaction.options.getString('message')
      const targetName = interaction.options.getString('bot')
      if (targetName) {
        const mc = getBot(targetName)
        if (!mc) return interaction.reply(`❌ Bot \`${targetName}\` not found.`)
        mc.chat(text)
        await interaction.reply({ content: `✅ **${targetName}** sent: **${text}**`, ephemeral: true })
      } else {
        let sent = 0
        for (const [, entry] of bots) {
          if (entry.active && entry.mc) { entry.mc.chat(text); sent++ }
        }
        await interaction.reply({ content: `✅ Sent from **${sent}** bot(s): **${text}**`, ephemeral: true })
      }
      break
    }

    case 'players': {
      const mc = firstBot()
      if (!mc) return interaction.reply('❌ No bots connected.')
      const players = Object.keys(mc.players)
      await interaction.reply(players.length === 0 ? 'No players online.' : `**Online (${players.length}):** ${players.join(', ')}`)
      break
    }

    case 'pos': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      const p = mc.entity.position
      await interaction.reply(`📍 X: \`${p.x.toFixed(1)}\` Y: \`${p.y.toFixed(1)}\` Z: \`${p.z.toFixed(1)}\``)
      break
    }

    case 'health': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      await interaction.reply(`❤️ **Health:** ${mc.health}/20 | 🍗 **Food:** ${mc.food}/20`)
      break
    }

    case 'jump': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      mc.setControlState('jump', true)
      setTimeout(() => mc.setControlState('jump', false), 500)
      await interaction.reply({ content: '✅ Jumped.', ephemeral: true })
      break
    }

    case 'walk': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      const dir = interaction.options.getString('direction')
      const duration = interaction.options.getInteger('duration') || 2000
      mc.setControlState(dir, true)
      setTimeout(() => mc.setControlState(dir, false), duration)
      await interaction.reply(`🚶 Walking **${dir}** for ${duration}ms`)
      break
    }

    case 'stop': {
      const targetName = interaction.options.getString('bot')
      const targets = targetName
        ? (bots.get(targetName) ? [bots.get(targetName)] : [])
        : [...bots.values()]
      targets.forEach(entry => {
        if (!entry.mc) return
        ;['forward','back','left','right','jump','sprint','sneak'].forEach(s => entry.mc.setControlState(s, false))
        if (entry.mc._followInterval) { clearInterval(entry.mc._followInterval); entry.mc._followInterval = null }
      })
      await interaction.reply({ content: `✅ Stopped ${targetName ? `\`${targetName}\`` : 'all bots'}.`, ephemeral: true })
      break
    }

    case 'follow': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      const target = interaction.options.getString('username')
      const player = mc.players[target]
      if (!player || !player.entity) return interaction.reply(`❌ Can't see \`${target}\``)
      if (mc._followInterval) clearInterval(mc._followInterval)
      mc._followInterval = setInterval(() => {
        const p = mc.players[target]
        if (!p || !p.entity) { clearInterval(mc._followInterval); return }
        mc.lookAt(p.entity.position.offset(0, p.entity.height, 0))
        mc.setControlState('forward', true)
        mc.setControlState('sprint', true)
      }, 250)
      await interaction.reply(`👣 Following **${target}**. Use \`/stop\` to cancel.`)
      break
    }

    case 'look': {
      const mc = getBot(interaction.options.getString('bot'))
      if (!mc) return interaction.reply('❌ Bot not found.')
      const target = interaction.options.getString('username')
      const player = mc.players[target]
      if (!player || !player.entity) return interaction.reply(`❌ Can't see \`${target}\``)
      await mc.lookAt(player.entity.position.offset(0, player.entity.height, 0))
      await interaction.reply({ content: '✅ Looking.', ephemeral: true })
      break
    }

    case 'reconnect': {
      const targetName = interaction.options.getString('bot')
      if (targetName) {
        const entry = bots.get(targetName)
        if (!entry) return interaction.reply(`❌ Bot \`${targetName}\` not found.`)
        if (entry.mc) entry.mc.end()
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
        await interaction.reply(`🔄 Reconnecting \`${targetName}\`...`)
        setTimeout(() => createBot(targetName), 1000)
      } else {
        const names = [...bots.keys()]
        names.forEach(name => {
          const entry = bots.get(name)
          if (entry.mc) entry.mc.end()
          if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
          setTimeout(() => createBot(name), 1000)
        })
        await interaction.reply(`🔄 Reconnecting **${names.length}** bot(s)...`)
      }
      break
    }

    case 'help': {
      const embed = new EmbedBuilder().setTitle('🤖 Minecraft Bot Commands').setColor(0x2ecc71)
        .addFields(
          { name: '/addbot [count]',        value: 'Spawn 1-10 bots (owner only)',          inline: false },
          { name: '/removebot <username>',   value: 'Disconnect a specific bot (owner only)', inline: false },
          { name: '/removeall',              value: 'Disconnect all bots (owner only)',       inline: false },
          { name: '/listbots',               value: 'List all active bots',                  inline: false },
          { name: '/say <msg> [bot]',        value: 'Send chat — all bots or one specific',  inline: false },
          { name: '/players',                value: 'List online players',                   inline: false },
          { name: '/pos [bot]',              value: 'Bot position',                          inline: false },
          { name: '/health [bot]',           value: 'Bot health and food',                   inline: false },
          { name: '/walk <dir> [ms] [bot]',  value: 'Move bot (owner only)',                 inline: false },
          { name: '/jump [bot]',             value: 'Make bot jump (owner only)',             inline: false },
          { name: '/follow <player> [bot]',  value: 'Follow a player (owner only)',          inline: false },
          { name: '/look <player> [bot]',    value: 'Look at a player',                      inline: false },
          { name: '/stop [bot]',             value: 'Stop movement — one or all (owner only)', inline: false },
          { name: '/reconnect [bot]',        value: 'Reconnect — one or all (owner only)',   inline: false },
        )
      await interaction.reply({ embeds: [embed] })
      break
    }
  }
})

// ─── Ready ─────────────────────────────────────────────────────────────────
discord.once('ready', async () => {
  console.log(`[Discord] Logged in as ${discord.user.tag}`)
  channel = discord.channels.cache.get(CHANNEL_ID)
  if (!channel) console.error('[Discord] Channel not found')
  await registerCommands()
  // Spawn one bot on startup
  createBot(pickUsername())
})

discord.login(DISCORD_TOKEN)
