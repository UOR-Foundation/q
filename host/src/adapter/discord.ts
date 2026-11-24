// The Discord adapter: turns a Discord event into the facts the pipeline and the
// memory need, and sends back what the pipeline returns, as the kernel decided to
// deliver it. Another platform is another implementation of ./adapter.ts.
import { readFile, writeFile } from 'node:fs/promises';
import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, type GuildMember, type Message } from 'discord.js';
import type { Config } from '../config.ts';
import type { ChannelFacts, CommandName } from '../kernel.ts';
import type { Observed } from '../memory.ts';
import { Aggregator } from '../aggregator.ts';
import { payloads, type Adapter, type Handlers, type Payload } from './adapter.ts';

const COMMANDS: [CommandName, string, boolean][] = [
  ['ask', 'Ask a question about the UOR Foundation', true],
  ['search', 'Search the indexed sources', true],
  ['status', 'Show the kernel and the index', false],
  ['reindex', 'Re-index the knowledge sources (admin)', false],
  ['forget-channel', 'Forget everything indexed from this channel (admin)', false],
  ['forget-me', 'Forget everything indexed from you, and stop indexing you', false],
];

// Discord refuses a message over 2000 characters.
const LIMIT = 2000;
const send = (payload: Payload) => ({
  content: payload.content,
  allowedMentions: { parse: [] },
  ...(payload.file ? { files: [new AttachmentBuilder(Buffer.from(payload.file.text, 'utf8'), { name: payload.file.name })] } : {}),
});
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }));

/** A channel's label, from the ids of the channel and its parent. The community decides it (governance/discord.json). */
export type Labeler = (ids: string[]) => ChannelFacts['label'];

export function discord(config: Config, label: Labeler): Adapter {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const aggregator = new Aggregator<Message>(config.aggregateMs);

  const facts = (channel: Message['channel'] | null): ChannelFacts => {
    const parent = channel && 'parent' in channel ? channel.parent : null;
    const kind =
      !channel || channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM ? 'dm'
      : channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice ? 'voice'
      : (channel.type as ChannelType) === ChannelType.GuildForum || parent?.type === ChannelType.GuildForum ? 'forum'
      : 'text';
    const guildChannel = channel && 'guild' in channel ? channel : null;
    const everyone = guildChannel?.permissionsFor(guildChannel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    // A thread carries the label of the channel it belongs to.
    const ids = [channel?.id, parent?.id].filter((id): id is string => Boolean(id));
    return {
      kind, label: label(ids),
      visibility: everyone ? 'everyone' : 'restricted',
      install: config.installedByAdmin ? 'admin' : 'other',
      intent: config.messageContentIntent ? 'granted' : 'missing',
    };
  };

  const role = (member: GuildMember | null | undefined) =>
    member && (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.some((r) => config.adminRoles.has(r.id))) ? 'admin' : 'member';

  const addressed = (message: Message) => message.mentions.users.has(client.user!.id) || message.mentions.repliedUser?.id === client.user!.id;
  /** `inRequest`: the message belongs to a burst that addressed the agent, so it is part of a question. */
  const observed = (message: Message, inRequest = false): Observed => {
    const thread = message.channel.isThread() ? message.channel : null;
    return {
      channel: facts(message.channel),
      channelId: thread?.parentId ?? message.channelId,
      threadId: thread?.id,
      authorId: message.author.id,
      // A message to the agent is a question, not knowledge: indexed, a repeated question would ground its own answer.
      origin: message.author.bot ? 'bot' : inRequest || addressed(message) ? 'request' : 'conversation',
      replyTo: message.reference?.messageId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.reference.messageId}` : undefined,
      url: message.url,
      createdMs: message.createdTimestamp,
      text: message.content,
    };
  };

  /** Connect and serve: index what the kernel admits, answer what it allows. */
  async function start(handlers: Handlers) {
    client.once(Events.ClientReady, async (ready) => {
      await ready.application.commands.set(
        COMMANDS.map(([name, description, question]) => {
          const command = new SlashCommandBuilder().setName(name).setDescription(description);
          if (question) command.addStringOption((option) => option.setName('question').setDescription('What to ask').setRequired(true));
          return command.toJSON();
        }),
      );
      log('ready', { user: ready.user.tag });
    });

    client.on(Events.MessageCreate, async (message) => {
      let inRequest = false;
      try {
        // LangBot's aggregator: a burst of messages from one person in one channel is one question, handled
        // when the burst ends, in reply to its last message. Earlier messages of the burst are folded in.
        const burst = message.author.bot ? null : await aggregator.offer(`${message.channelId}:${message.author.id}`, message);
        inRequest = Boolean(burst && burst.items.some(addressed));
        const batch = burst && burst.last ? burst.items : null;
        if (batch) {
          const me = client.user!.id;
          const triggerOf = (m: Message) => (m.mentions.users.has(me) ? (m.reference && m.mentions.repliedUser?.id === me ? 'replyToAgent' : 'mention') : 'none');
          const triggers = batch.map(triggerOf);
          const trigger = triggers.includes('replyToAgent') ? 'replyToAgent' : triggers.includes('mention') ? 'mention' : 'none';
          const text = batch.map((m) => m.content.replaceAll(`<@${me}>`, '').trim()).filter(Boolean).join('\n');
          // "Q is typing" from the moment the kernel decides to answer until the reply is sent; Discord
          // shows it for ten seconds, so it is renewed.
          let working = false;
          let typing: ReturnType<typeof setInterval> | undefined;
          const show = () => {
            if ('sendTyping' in message.channel) message.channel.sendTyping().catch(() => {});
          };
          try {
            const reply = await handlers.handle({
              channel: facts(message.channel),
              channelId: message.channelId,
              authorId: message.author.id,
              role: role(message.member),
              trigger,
              text,
              working: () => { working = true; show(); typing = setInterval(show, 8000); },
            });
            clearInterval(typing);
            if (reply) {
              for (const payload of payloads(reply, LIMIT)) await message.reply(send(payload));
              log('reply', { decision: reply.decision, citations: reply.citations.length, delivery: reply.delivery, ms: reply.timings });
            }
          } catch (error) {
            clearInterval(typing);
            console.error(JSON.stringify({ event: 'error', message: String(error) }));
            // The kernel had decided to answer: an answer that failed is said, not left as silence.
            if (working) await message.reply(send({ content: "I couldn't answer just now: the language model is busy or unreachable. Please try again in a minute." })).catch(() => {});
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'error', message: String(error) }));
      }
      // Indexed only after it is answered, so a question is never cited as its own source.
      try {
        log('observed', { decision: await handlers.observe(observed(message, inRequest)) });
      } catch (error) {
        console.error(JSON.stringify({ event: 'error', message: String(error) }));
      }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      // Forgetting is between the author and the agent; everything else is answered in the open.
      await interaction.deferReply({ ephemeral: interaction.commandName === 'forget-me' });
      try {
        const reply = await handlers.handle({
          channel: facts(interaction.channel as Message['channel'] | null),
          channelId: interaction.channelId,
          authorId: interaction.user.id,
          role: role(interaction.member as GuildMember | null),
          trigger: 'slash',
          command: interaction.commandName as CommandName,
          text: interaction.options.getString('question') ?? '',
        });
        const [first, ...rest] = reply ? payloads(reply, LIMIT) : [{ content: 'No reply in this channel.' }];
        await interaction.editReply(send(first));
        for (const payload of rest) await interaction.followUp(send(payload));
        log('reply', { decision: reply?.decision ?? 'silent', command: interaction.commandName, delivery: reply?.delivery ?? 'send', ms: reply?.timings });
      } catch (error) {
        console.error(JSON.stringify({ event: 'error', message: String(error) }));
        await interaction.editReply("I couldn't answer just now: the language model is busy or unreachable. Please try again in a minute.");
      }
    });

    await client.login(config.discordToken);
  }

  /**
   * Read the history of every text channel of every server the agent is in, newest page first, and offer each
   * message to the memory, where the kernel decides it from the channel's facts and the community's label.
   * The place reached in each channel is written after every page, so a stopped run resumes where it was.
   * discord.js waits out Discord's rate limits itself.
   */
  async function backfill(observe: Handlers['observe']) {
    await client.login(config.discordToken);
    let cursors: Record<string, string> = {};
    try {
      cursors = JSON.parse(await readFile(config.backfillFile, 'utf8'));
    } catch {
      // No file yet: start from the newest message.
    }
    const channels = [];
    for (const guild of (await client.guilds.fetch()).values()) channels.push(...(await (await guild.fetch()).channels.fetch()).values());
    for (const channel of channels) {
      if (!channel || !channel.isTextBased() || !('messages' in channel)) continue;
      const id = channel.id;
      let seen = 0, indexed = 0;
      for (;;) {
        const page = await channel.messages.fetch({ limit: 100, ...(cursors[id] ? { before: cursors[id] } : {}) });
        if (page.size === 0) break;
        for (const message of page.values()) {
          seen++;
          if ((await observe(observed(message))) === 'index') indexed++;
        }
        cursors[id] = page.last()!.id;
        await writeFile(config.backfillFile, JSON.stringify(cursors));
        log('backfill', { channel: id, seen, indexed });
      }
    }
    await client.destroy();
  }

  return { start, backfill };
}
