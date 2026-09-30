const mineflayer = require('mineflayer')
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js')
const http = require('http')
require('dotenv').config()

// ─── Config (all from environment variables) ───────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CLIENT_ID     = process.env.CLIENT_ID
const GUILD_ID      = process.env.GUILD_ID
const CHANNEL_ID    = process.env.CHANNEL_ID
const OWNER_ID      = process.env.OWNER_ID
const MC_HOST       = process.env.MC_HOST
const MC_PORT       = parseInt(process.env.MC_PORT || '25565')
const MC_VERSION    = process.env.MC_VERSION || '1.20.1'

// ─── Validate required env vars ────────────────────────────────────────────
const required = { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, CHANNEL_ID, OWNER_ID, MC_HOST }
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`)
  console.error('[ERROR] Create a .env file or set these in Railway Variables.')
  process.exit(1)
}

// ─── Keep Railway alive ────────────────────────────────────────────────────
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000)

// ─── Custom Username Pool ──────────────────────────────────────────────────
const MC_USERNAMES = ['ShadowRelay','GhostBridge','NullWatcher','VoidLink','EchoNode']
function pickUsername() { return MC_USERNAMES[Math.floor(Math.random() * MC_USERNAMES.length)] }

// ─── Slash Command Definitions ─────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('say').setDescription('Send a chat message in-game')
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)),
  new SlashCommandBuilder().setName('players').setDescription('List online players'),
  new SlashCommandBuilder().setName('pos').setDescription('Show bot current position'),
  new SlashCommandBuilder().setName('health').setDescription('Show bot health and food'),
  new SlashCommandBuilder().setName('inventory').setDescription('Show bot inventory'),
  new SlashCommandBuilder().setName('jump').setDescription('Make the bot jump (owner only)'),
  new SlashCommandBuilder().setName('walk').setDescription('Move the bot (owner only)')
    .addStringOption(o => o.setName('direction').setDescription('Direction').setRequired(true)
      .addChoices(
        { name: 'Forward', value: 'forward' },
        { name: 'Back',    value: 'back'    },
        { name: 'Left',    value: 'left'    },
        { name: 'Right',   value: 'right'   }
      ))
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in ms (default 2000)').setRequired(false)),
  new SlashCommandBuilder().setName('stop').setDescription('Stop all bot movement (owner only)'),
  new SlashCommandBuilder().setName('follow').setDescription('Follow a player (owner only)')
    .addStringOption(o => o.setName('username').setDescription('Player to follow').setRequired(true)),
  new SlashCommandBuilder().setName('look').setDescription('Look at a player')
    .addStringOption(o => o.setName('username').setDescription('Player to look at').setRequired(true)),
  new SlashCommandBuilder().setName('reconnect').setDescription('Reconnect the MC bot (owner only)'),
  new SlashCommandBuilder().setName('username').setDescription('Show the bot current MC username'),
  new SlashCommandBuilder().setName('help').setDescription('List all commands'),
].map(c => c.toJSON())

// ─── Register Slash Commands ───────────────────────────────────────────────
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

let mc = null, channel = null, reconnectTimer = null, reconnectDelay = 15000
let currentUsername = pickUsername()

// ─── Minecraft Bot Factory ─────────────────────────────────────────────────
function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  currentUsername = pickUsername()

  mc = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: currentUsername,
    version: MC_VERSION,
    auth: 'offline',
    hideErrors: false,
    checkTimeoutInterval: 30000
  })

  mc.on('login', () => {
    reconnectDelay = 15000
    console.log(`[MC] Logged in as ${mc.username}`)
    sendToDiscord(`✅ **Bot joined** \`${MC_HOST}\` as \`${currentUsername}\``)
  })

  mc.on('chat', (username, message) => {
    if (username === mc.username) return
    if (channel) channel.send(`💬 **${username}**: ${message}`).catch(() => {})
  })

  mc.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    if (!text.includes('<') && text.trim().length > 0)
      if (channel) channel.send(`📢 ${text.slice(0, 1900)}`).catch(() => {})
  })

  mc.on('kicked', (reason) => {
    console.log(`[MC] Kicked: ${reason}`)
    sendToDiscord(`⚠️ **Bot was kicked**: ${reason}\nReconnecting in ${reconnectDelay / 1000}s...`)
    scheduleReconnect()
  })

  mc.on('end', (reason) => {
    console.log(`[MC] Connection ended: ${reason}`)
    sendToDiscord(`🔴 **Bot disconnected** (${reason || 'unknown'}). Reconnecting in ${reconnectDelay / 1000}s...`)
    scheduleReconnect()
  })

  mc.on('error', (err) => {
    console.error(`[MC ERROR] ${err.message}`)
    sendToDiscord(`❌ **MC Error**: ${err.message}`)
  })

  mc.on('death', () => { mc.respawn(); sendToDiscord(`💀 **Bot died** — respawning`) })
  mc.on('spawn', () => console.log('[MC] Bot spawned'))
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 120000)
    console.log('[MC] Reconnecting...')
    createBot()
  }, reconnectDelay)
}

function sendToDiscord(msg) { if (channel) channel.send(msg).catch(() => {}) }
function isOwner(i) { return i.user.id === OWNER_ID }

// ─── Slash Command Handler ─────────────────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.channelId !== CHANNEL_ID)
    return interaction.reply({ content: '❌ Wrong channel.', ephemeral: true })

  const { commandName } = interaction
  const ownerOnly = ['stop','reconnect','jump','walk','follow']

  if (ownerOnly.includes(commandName) && !isOwner(interaction))
    return interaction.reply({ content: '❌ Owner only.', ephemeral: true })

  if (!mc && commandName !== 'reconnect')
    return interaction.reply({ content: '❌ MC bot not connected.', ephemeral: true })

  switch (commandName) {
    case 'say': {
      const text = interaction.options.getString('message')
      mc.chat(text)
      await interaction.reply({ content: `✅ Sent: **${text}**`, ephemeral: true })
      break
    }
    case 'players': {
      const players = Object.keys(mc.players)
      await interaction.reply(players.length === 0 ? 'No players online.' : `**Online (${players.length}):** ${players.join(', ')}`)
      break
    }
    case 'pos': {
      const p = mc.entity.position
      await interaction.reply(`📍 X: \`${p.x.toFixed(1)}\` Y: \`${p.y.toFixed(1)}\` Z: \`${p.z.toFixed(1)}\``)
      break
    }
    case 'health': {
      await interaction.reply(`❤️ **Health:** ${mc.health}/20 | 🍗 **Food:** ${mc.food}/20`)
      break
    }
    case 'jump': {
      mc.setControlState('jump', true)
      setTimeout(() => mc.setControlState('jump', false), 500)
      await interaction.reply({ content: '✅ Jumped.', ephemeral: true })
      break
    }
    case 'walk': {
      const dir = interaction.options.getString('direction')
      const duration = interaction.options.getInteger('duration') || 2000
      mc.setControlState(dir, true)
      setTimeout(() => mc.setControlState(dir, false), duration)
      await interaction.reply(`🚶 Walking **${dir}** for ${duration}ms`)
      break
    }
    case 'stop': {
      ;['forward','back','left','right','jump','sprint','sneak'].forEach(s => mc.setControlState(s, false))
      if (mc._followInterval) { clearInterval(mc._followInterval); mc._followInterval = null }
      await interaction.reply({ content: '✅ Stopped.', ephemeral: true })
      break
    }
    case 'follow': {
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
      const target = interaction.options.getString('username')
      const player = mc.players[target]
      if (!player || !player.entity) return interaction.reply(`❌ Can't see \`${target}\``)
      await mc.lookAt(player.entity.position.offset(0, player.entity.height, 0))
      await interaction.reply({ content: '✅ Looking.', ephemeral: true })
      break
    }
    case 'reconnect': {
      if (mc) mc.end()
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      await interaction.reply('🔄 Reconnecting...')
      setTimeout(createBot, 1000)
      break
    }
    case 'username': {
      await interaction.reply(`🎮 Connected as \`${currentUsername}\``)
      break
    }
    case 'help': {
      const embed = new EmbedBuilder().setTitle('🤖 Minecraft Bot Commands').setColor(0x2ecc71)
        .addFields(
          { name: '/say <msg>',       value: 'Send chat message in-game',         inline: false },
          { name: '/players',         value: 'List online players',               inline: false },
          { name: '/pos',             value: 'Bot current position',              inline: false },
          { name: '/health',          value: 'Bot health and food',               inline: false },
          { name: '/inventory',       value: 'Show bot inventory',                inline: false },
          { name: '/username',        value: 'Show current MC username',          inline: false },
          { name: '/walk <dir> [ms]', value: 'Move bot (owner only)',             inline: false },
          { name: '/jump',            value: 'Make bot jump (owner only)',        inline: false },
          { name: '/follow <player>', value: 'Follow a player (owner only)',      inline: false },
          { name: '/look <player>',   value: 'Look at a player',                 inline: false },
          { name: '/stop',            value: 'Stop all movement (owner only)',    inline: false },
          { name: '/reconnect',       value: 'Reconnect to server (owner only)', inline: false },
        )
      await interaction.reply({ embeds: [embed] })
      break
    }
  }
})

// ─── Discord Ready ─────────────────────────────────────────────────────────
discord.once('ready', async () => {
  console.log(`[Discord] Logged in as ${discord.user.tag}`)
  channel = discord.channels.cache.get(CHANNEL_ID)
  if (!channel) console.error('[Discord] Channel not found — check CHANNEL_ID')
  await registerCommands()
  createBot()
})

discord.login(DISCORD_TOKEN)
