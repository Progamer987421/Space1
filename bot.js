const mineflayer = require('mineflayer')
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js')

// ─── Config (set these in Railway's environment variables) ─────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CLIENT_ID     = process.env.CLIENT_ID
const GUILD_ID      = process.env.GUILD_ID
const CHANNEL_ID    = process.env.CHANNEL_ID
const OWNER_ID      = process.env.OWNER_ID
const MC_HOST       = process.env.MC_HOST       || 'play.applemc.net'
const MC_PORT       = parseInt(process.env.MC_PORT || '25565', 10)
const MC_VERSION    = process.env.MC_VERSION    || '1.20.1'

// Validate required env vars at startup so Railway crash logs are readable
const required = { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, CHANNEL_ID, OWNER_ID }
for (const [key, val] of Object.entries(required)) {
  if (!val) { console.error(`[FATAL] Missing env var: ${key}`); process.exit(1) }
}

// ─── Default Username Pool ─────────────────────────────────────────────────
const MC_USERNAMES = ['ShadowRelay', 'GhostBridge', 'NullWatcher', 'VoidLink', 'EchoNode']
function pickUsername() {
  return MC_USERNAMES[Math.floor(Math.random() * MC_USERNAMES.length)]
}

// ─── Bot Registry ──────────────────────────────────────────────────────────
// Map<botId: string, { mc, username, reconnectTimer, reconnectDelay }>
const bots = new Map()

// ─── Slash Command Definitions ─────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('say').setDescription('Send a chat message in-game (all bots or one bot)')
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('players').setDescription('List online players (first connected bot)'),

  new SlashCommandBuilder().setName('pos').setDescription('Show bot position')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('health').setDescription('Show bot health and food')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('inventory').setDescription('Show bot inventory')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('jump').setDescription('Make a bot jump (owner only)')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('walk').setDescription('Move a bot (owner only)')
    .addStringOption(o =>
      o.setName('direction').setDescription('Direction').setRequired(true)
        .addChoices(
          { name: 'Forward', value: 'forward' },
          { name: 'Back',    value: 'back'    },
          { name: 'Left',    value: 'left'    },
          { name: 'Right',   value: 'right'   }
        )
    )
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in ms (default 2000)').setRequired(false))
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('stop').setDescription('Stop all bot movement (owner only)')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('follow').setDescription('Follow a player (owner only)')
    .addStringOption(o => o.setName('username').setDescription('Player to follow').setRequired(true))
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('look').setDescription('Look at a player')
    .addStringOption(o => o.setName('username').setDescription('Player to look at').setRequired(true))
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('reconnect').setDescription('Reconnect a bot (owner only)')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('username').setDescription('Show bot username(s)')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID (omit = all bots)').setRequired(false)),

  new SlashCommandBuilder().setName('bots').setDescription('List all active bots and their usernames'),

  new SlashCommandBuilder().setName('addbot').setDescription('Spawn a new bot (owner only)')
    .addStringOption(o => o.setName('username').setDescription('Custom MC username (omit = random from pool)').setRequired(false))
    .addStringOption(o => o.setName('botid').setDescription('Custom ID for this bot (omit = auto-generated)').setRequired(false)),

  new SlashCommandBuilder().setName('removebot').setDescription('Kill and remove a bot (owner only)')
    .addStringOption(o => o.setName('botid').setDescription('Bot ID to remove').setRequired(true)),

  new SlashCommandBuilder().setName('setusername').setDescription('Change a bot\'s username and reconnect (owner only)')
    .addStringOption(o => o.setName('username').setDescription('New MC username').setRequired(true))
    .addStringOption(o => o.setName('botid').setDescription('Bot ID to rename (omit = first bot)').setRequired(false)),

  new SlashCommandBuilder().setName('help').setDescription('List all commands'),
].map(c => c.toJSON())

// ─── Register Slash Commands ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
  try {
    console.log('[Discord] Registering slash commands...')
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
    console.log('[Discord] Slash commands live.')
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err)
  }
}

// ─── Discord Client ─────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

let channel = null

// ─── Minecraft Bot Factory ──────────────────────────────────────────────────
function createBot(username, botId) {
  if (!username) username = pickUsername()
  if (!botId)   botId   = `bot_${Date.now()}`

  const existing = bots.get(botId)
  if (existing) {
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer)
    if (existing.mc) try { existing.mc.end() } catch (_) {}
  }

  // transferring: true means the bot is mid-Bungeecord server switch — treat end/kicked as expected
  const entry = { mc: null, username, reconnectTimer: null, reconnectDelay: 5000, transferring: false }
  bots.set(botId, entry)

  const mc = mineflayer.createBot({
    host:    MC_HOST,
    port:    MC_PORT,
    username,
    version: MC_VERSION,
    auth:    'offline'
  })

  entry.mc = mc

  mc.on('login', () => {
    entry.reconnectDelay = 5000
    entry.transferring   = false
    console.log(`[MC][${botId}] Logged in as ${mc.username}`)
    sendToDiscord(`✅ **[${botId}]** joined \`${MC_HOST}\` as \`${username}\``)
  })

  mc.on('chat', (sender, message) => {
    if (sender === mc.username) return
    console.log(`[MC][${botId}] <${sender}> ${message}`)
    if (channel) channel.send(`💬 **[${botId}] ${sender}**: ${message}`).catch(() => {})
  })

  mc.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    if (!text.includes('<') && text.trim().length > 0) {
      console.log(`[MC][${botId}] ${text}`)
      if (channel) channel.send(`📢 **[${botId}]** ${text.slice(0, 1880)}`).catch(() => {})
    }
  })

  // Bungeecord server switches arrive as a kick with "Connecting to <realm>" or similar.
  // Flag the transfer so the 'end' handler doesn't treat it as a real disconnect.
  mc.on('kicked', (reason) => {
    const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : String(reason)
    const isBungeeTransfer = /connecting to|you are already connected|server switch|transferring/i.test(reasonStr)

    if (isBungeeTransfer) {
      entry.transferring = true
      console.log(`[MC][${botId}] Bungeecord transfer detected: ${reasonStr}`)
      sendToDiscord(`🔀 **[${botId}]** switching servers — reconnecting...`)
      // Reconnect immediately, no backoff — this is an expected transition
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null
        createBot(entry.username, botId)
      }, 2000)
    } else {
      console.log(`[MC][${botId}] Kicked: ${reasonStr}`)
      sendToDiscord(`⚠️ **[${botId}]** kicked: ${reasonStr}\nReconnecting in ${entry.reconnectDelay / 1000}s...`)
      scheduleReconnect(botId)
    }
  })

  mc.on('end', () => {
    if (!bots.has(botId)) return
    // Bungeecord transfer: kicked handler already queued a fast reconnect, skip the slow one
    if (entry.transferring) {
      entry.transferring = false
      return
    }
    // Everything else — timeout, ECONNRESET, server restart, normal disconnect — goes here
    console.log(`[MC][${botId}] Connection ended — reconnecting in ${entry.reconnectDelay / 1000}s`)
    sendToDiscord(`🔴 **[${botId}]** disconnected. Reconnecting in ${entry.reconnectDelay / 1000}s...`)
    scheduleReconnect(botId)
  })

  mc.on('error', (err) => {
    const msg = err.message || ''
    // These are all expected disconnects — mineflayer fires 'error' before 'end' for these.
    // Let the 'end' handler (or the kicked handler) own the reconnect. Don't double-report.
    const isExpected = (
      entry.transferring ||
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      /timed out/i.test(msg) ||
      /client timed out/i.test(msg) ||
      /connection reset/i.test(msg) ||
      /read ECONNRESET/i.test(msg)
    )
    if (isExpected) {
      console.log(`[MC][${botId}] Expected disconnect (${msg || err.code}) — reconnect queued`)
      return
    }
    console.error(`[MC][${botId}] ${msg}`)
    sendToDiscord(`❌ **[${botId}] Error**: ${msg}`)
  })

  mc.on('death', () => {
    mc.respawn()
    sendToDiscord(`💀 **[${botId}]** died — respawning`)
  })

  mc.on('spawn', () => console.log(`[MC][${botId}] Spawned`))

  return botId
}

function scheduleReconnect(botId) {
  const entry = bots.get(botId)
  if (!entry || entry.reconnectTimer) return
  entry.reconnectTimer = setTimeout(() => {
    const e = bots.get(botId)
    if (!e) return
    e.reconnectTimer = null
    e.reconnectDelay = Math.min(e.reconnectDelay * 2, 60000)
    console.log(`[MC][${botId}] Reconnecting...`)
    createBot(e.username, botId)
  }, entry.reconnectDelay)
}

function sendToDiscord(msg) {
  if (channel) channel.send(msg).catch(() => {})
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function isOwner(interaction) {
  return interaction.user.id === OWNER_ID
}

function firstBot() {
  for (const [id, entry] of bots) {
    if (entry.mc) return [id, entry]
  }
  return [null, null]
}

function resolveBot(botId) {
  if (botId) return [botId, bots.get(botId) || null]
  return firstBot()
}

function stopMovement(mc) {
  ;['forward','back','left','right','jump','sprint','sneak'].forEach(s => mc.setControlState(s, false))
  if (mc._followInterval) { clearInterval(mc._followInterval); mc._followInterval = null }
}

// ─── Slash Command Handler ──────────────────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.channelId !== CHANNEL_ID) {
    return interaction.reply({ content: '❌ Wrong channel.', ephemeral: true })
  }

  const { commandName } = interaction
  const ownerOnly = ['stop','reconnect','jump','walk','follow','addbot','removebot','setusername']

  if (ownerOnly.includes(commandName) && !isOwner(interaction)) {
    return interaction.reply({ content: '❌ Owner only.', ephemeral: true })
  }

  const botIdOpt = interaction.options.getString?.('botid') || null

  switch (commandName) {

    case 'addbot': {
      const customName = interaction.options.getString('username') || null
      const customId   = interaction.options.getString('botid')   || null
      const assignedId = createBot(customName, customId)
      await interaction.reply(`✅ Spawning bot **[${assignedId}]** as \`${bots.get(assignedId).username}\``)
      break
    }

    case 'removebot': {
      const id    = interaction.options.getString('botid')
      const entry = bots.get(id)
      if (!entry) return interaction.reply({ content: `❌ No bot with ID \`${id}\``, ephemeral: true })
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      if (entry.mc) try { entry.mc.end() } catch (_) {}
      bots.delete(id)
      await interaction.reply(`🗑️ Bot **[${id}]** removed.`)
      break
    }

    case 'setusername': {
      const newName     = interaction.options.getString('username')
      const [id, entry] = resolveBot(botIdOpt)
      if (!id || !entry) return interaction.reply({ content: '❌ No bot found.', ephemeral: true })
      const oldName = entry.username
      entry.username = newName
      if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
      if (entry.mc) try { entry.mc.end() } catch (_) {}
      await interaction.reply(`🔄 **[${id}]** username changing from \`${oldName}\` → \`${newName}\`. Reconnecting...`)
      setTimeout(() => createBot(newName, id), 1000)
      break
    }

    case 'bots': {
      if (bots.size === 0) return interaction.reply('No active bots.')
      const lines = [...bots.entries()].map(([id, e]) => `• \`${id}\` — \`${e.username}\``)
      await interaction.reply(`🤖 **Active Bots (${bots.size}):**\n${lines.join('\n')}`)
      break
    }

    case 'username': {
      if (bots.size === 0) return interaction.reply('No active bots.')
      if (botIdOpt) {
        const entry = bots.get(botIdOpt)
        if (!entry) return interaction.reply({ content: `❌ No bot \`${botIdOpt}\``, ephemeral: true })
        return interaction.reply(`🎮 **[${botIdOpt}]** → \`${entry.username}\``)
      }
      const lines = [...bots.entries()].map(([id, e]) => `• \`${id}\` → \`${e.username}\``)
      await interaction.reply(`🎮 **Bot Usernames:**\n${lines.join('\n')}`)
      break
    }

    case 'say': {
      const text = interaction.options.getString('message')
      if (bots.size === 0) return interaction.reply({ content: '❌ No bots connected.', ephemeral: true })
      if (botIdOpt) {
        const entry = bots.get(botIdOpt)
        if (!entry || !entry.mc) return interaction.reply({ content: `❌ No bot \`${botIdOpt}\``, ephemeral: true })
        entry.mc.chat(text)
        return interaction.reply({ content: `✅ **[${botIdOpt}]** sent: **${text}**`, ephemeral: true })
      }
      bots.forEach((e) => { if (e.mc) e.mc.chat(text) })
      await interaction.reply({ content: `✅ All bots sent: **${text}**`, ephemeral: true })
      break
    }

    case 'players': {
      const [, entry] = firstBot()
      if (!entry) return interaction.reply({ content: '❌ No bots connected.', ephemeral: true })
      const players = Object.keys(entry.mc.players)
      await interaction.reply(players.length ? `**Online (${players.length}):** ${players.join(', ')}` : 'No players online.')
      break
    }

    case 'pos': {
      const [id, entry] = resolveBot(botIdOpt)
      if (!id || !entry?.mc) return interaction.reply({ content: '❌ No bot found.', ephemeral: true })
      const p = entry.mc.entity.position
      await interaction.reply(`📍 **[${id}] Position:** X: \`${p.x.toFixed(1)}\` Y: \`${p.y.toFixed(1)}\` Z: \`${p.z.toFixed(1)}\``)
      break
    }

    case 'health': {
      const [id, entry] = resolveBot(botIdOpt)
      if (!id || !entry?.mc) return interaction.reply({ content: '❌ No bot found.', ephemeral: true })
      await interaction.reply(`❤️ **[${id}] Health:** ${entry.mc.health}/20 | 🍗 **Food:** ${entry.mc.food}/20`)
      break
    }

    case 'inventory': {
      const [id, entry] = resolveBot(botIdOpt)
      if (!id || !entry?.mc) return interaction.reply({ content: '❌ No bot found.', ephemeral: true })
      const items = entry.mc.inventory.items()
      if (!items.length) return interaction.reply(`**[${id}]** Inventory is empty.`)
      await interaction.reply(`🎒 **[${id}] Inventory:**\n${items.map(i => `• ${i.name} x${i.count}`).join('\n')}`)
      break
    }

    case 'jump': {
      if (bots.size === 0) return interaction.reply({ content: '❌ No bots connected.', ephemeral: true })
      const targets = botIdOpt ? [bots.get(botIdOpt)] : [...bots.values()]
      targets.filter(Boolean).forEach(e => {
        if (!e.mc) return
        e.mc.setControlState('jump', true)
        setTimeout(() => e.mc.setControlState('jump', false), 500)
      })
      await interaction.reply({ content: `✅ Jumped${botIdOpt ? ` [${botIdOpt}]` : ' (all bots)'}.`, ephemeral: true })
      break
    }

    case 'walk': {
      const dir      = interaction.options.getString('direction')
      const duration = interaction.options.getInteger('duration') || 2000
      const targets  = botIdOpt ? [bots.get(botIdOpt)] : [...bots.values()]
      targets.filter(Boolean).forEach(e => {
        if (!e.mc) return
        e.mc.setControlState(dir, true)
        setTimeout(() => e.mc.setControlState(dir, false), duration)
      })
      await interaction.reply(`🚶 Walking **${dir}** for ${duration}ms${botIdOpt ? ` [${botIdOpt}]` : ' (all bots)'}`)
      break
    }

    case 'stop': {
      const targets = botIdOpt ? [bots.get(botIdOpt)] : [...bots.values()]
      targets.filter(Boolean).forEach(e => { if (e.mc) stopMovement(e.mc) })
      await interaction.reply({ content: `✅ Stopped${botIdOpt ? ` [${botIdOpt}]` : ' (all bots)'}.`, ephemeral: true })
      break
    }

    case 'follow': {
      const target  = interaction.options.getString('username')
      const targets = botIdOpt ? [bots.get(botIdOpt)] : [...bots.values()]
      targets.filter(Boolean).forEach(e => {
        if (!e.mc) return
        const player = e.mc.players[target]
        if (!player || !player.entity) return
        if (e.mc._followInterval) clearInterval(e.mc._followInterval)
        e.mc._followInterval = setInterval(() => {
          const p = e.mc.players[target]
          if (!p || !p.entity) { clearInterval(e.mc._followInterval); return }
          e.mc.lookAt(p.entity.position.offset(0, p.entity.height, 0))
          e.mc.setControlState('forward', true)
          e.mc.setControlState('sprint',  true)
        }, 250)
      })
      await interaction.reply(`👣 Following **${target}**${botIdOpt ? ` [${botIdOpt}]` : ' (all bots)'}. Use \`/stop\` to cancel.`)
      break
    }

    case 'look': {
      const target      = interaction.options.getString('username')
      const [id, entry] = resolveBot(botIdOpt)
      if (!id || !entry?.mc) return interaction.reply({ content: '❌ No bot found.', ephemeral: true })
      const player = entry.mc.players[target]
      if (!player || !player.entity) return interaction.reply(`❌ Can't see \`${target}\``)
      await entry.mc.lookAt(player.entity.position.offset(0, player.entity.height, 0))
      await interaction.reply({ content: `✅ [${id}] Looking at **${target}**.`, ephemeral: true })
      break
    }

    case 'reconnect': {
      if (bots.size === 0 && !botIdOpt) return interaction.reply({ content: '❌ No bots to reconnect.', ephemeral: true })
      if (botIdOpt) {
        const entry = bots.get(botIdOpt)
        if (!entry) return interaction.reply({ content: `❌ No bot \`${botIdOpt}\``, ephemeral: true })
        if (entry.mc) try { entry.mc.end() } catch (_) {}
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
        await interaction.reply(`🔄 Reconnecting **[${botIdOpt}]**...`)
        setTimeout(() => createBot(entry.username, botIdOpt), 1000)
      } else {
        const entries = [...bots.entries()]
        entries.forEach(([id, entry]) => {
          if (entry.mc) try { entry.mc.end() } catch (_) {}
          if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null }
          setTimeout(() => createBot(entry.username, id), 1000)
        })
        await interaction.reply(`🔄 Reconnecting all **${entries.length}** bots...`)
      }
      break
    }

    case 'help': {
      const embed = new EmbedBuilder()
        .setTitle('🤖 Minecraft Bot Commands')
        .setColor(0x2ecc71)
        .addFields(
          { name: '/addbot [username] [botid]',     value: 'Spawn a new bot with optional custom username & ID (owner)',  inline: false },
          { name: '/removebot <botid>',              value: 'Kill and remove a bot (owner)',                               inline: false },
          { name: '/setusername <username> [botid]', value: 'Change a bot\'s username and reconnect (owner)',              inline: false },
          { name: '/bots',                           value: 'List all active bots and usernames',                          inline: false },
          { name: '/username [botid]',               value: 'Show current username(s)',                                    inline: false },
          { name: '/say <msg> [botid]',              value: 'Send chat (omit botid = all bots)',                           inline: false },
          { name: '/players',                        value: 'List online players',                                         inline: false },
          { name: '/pos [botid]',                    value: 'Bot position',                                                inline: false },
          { name: '/health [botid]',                 value: 'Bot health and food',                                         inline: false },
          { name: '/inventory [botid]',              value: 'Bot inventory',                                               inline: false },
          { name: '/walk <dir> [ms] [botid]',        value: 'Move bot (owner)',                                            inline: false },
          { name: '/jump [botid]',                   value: 'Jump (owner)',                                                inline: false },
          { name: '/follow <player> [botid]',        value: 'Follow a player (owner)',                                     inline: false },
          { name: '/look <player> [botid]',          value: 'Look at a player',                                            inline: false },
          { name: '/stop [botid]',                   value: 'Stop movement (owner)',                                       inline: false },
          { name: '/reconnect [botid]',              value: 'Reconnect bot(s) (owner)',                                    inline: false },
        )
      await interaction.reply({ embeds: [embed] })
      break
    }
  }
})

// ─── Discord Ready ──────────────────────────────────────────────────────────
discord.once('ready', async () => {
  console.log(`[Discord] Logged in as ${discord.user.tag}`)
  channel = discord.channels.cache.get(CHANNEL_ID)
  if (!channel) console.error('[Discord] Channel not found — check CHANNEL_ID')
  await registerCommands()
  createBot()
})

discord.login(DISCORD_TOKEN)
