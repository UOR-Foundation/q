// The Discord adapter: turns a Discord event into the facts the pipeline and the
// memory need, and sends back what the pipeline returns, as the kernel decided to
// deliver it. Another platform is another implementation of ./adapter.ts.
import { readFile, writeFile } from 'node:fs/promises';
import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Message, type MessageReaction, type PartialMessage, type PartialMessageReaction, type PartialUser, type User } from 'discord.js';
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
  ['improve', 'What Q is learning, and what it proposes to change (admin)', false],
  ['feedback', 'Tell Q what to do better, or ask for a feature. Shared with the community, without your name.', false],
  ['open', 'Open questions, promises and requests in this server (admin)', false],
  ['build', 'Describe an app: Q builds it, proves it, and links it running in its own holospace', false],
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
  // Partial messages: a deletion or an edit of a message sent before Q started still arrives, as its id and link.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });
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
      role: role(message.member),
      url: message.url,
      createdMs: message.createdTimestamp,
      text: message.content,
    };
  };

  /** Connect and serve: index what the kernel admits, answer what it allows. */
  async function start(handlers: Handlers) {
    const settle = async (rules: NonNullable<Config['membership']>) => {
      const channel = await client.channels.fetch(rules.channel);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(rules.message);
      const reaction = message.reactions.cache.find((r) => r.emoji.name === rules.emoji);
      if (!reaction) return;
      const guild = await client.guilds.fetch(rules.guild);
      let after: string | undefined, granted = 0, seen = 0;
      for (;;) {
        const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
        if (users.size === 0) break;
        for (const user of users.values()) {
          seen++;
          if ((await handlers.membership(true, !user.bot, true)) !== 'grant') continue;
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (member && !member.roles.cache.has(rules.role)) { await member.roles.add(rules.role, 'Confirmed the rules'); granted++; }
        }
        after = users.last()!.id;
      }
      log('membership-settled', { seen, granted });
    };
    client.once(Events.ClientReady, async (ready) => {
      await ready.application.commands.set(
        // /build is offered only where a builder is configured; elsewhere members never see it.
        COMMANDS.filter(([name]) => name !== 'build' || Boolean(config.builderUrl)).map(([name, description, question]) => {
          const command = new SlashCommandBuilder().setName(name).setDescription(description);
          if (question) command.addStringOption((option) => option.setName('question').setDescription('What to ask').setRequired(true));
          if (name === 'build') command.addStringOption((option) => option.setName('prompt').setDescription('What the app should decide, in your words').setRequired(true).setMaxLength(1500));
          if (name === 'feedback') {
            command.addStringOption((option) => option.setName('kind').setDescription('What it is').setRequired(true)
              .addChoices({ name: 'An idea or a feature', value: 'idea' }, { name: 'Something went wrong', value: 'problem' }, { name: 'Something went well', value: 'praise' }));
            command.addStringOption((option) => option.setName('text').setDescription('In your words').setRequired(true).setMaxLength(1500));
          }
          return command.toJSON();
        }),
      );
      log('ready', { user: ready.user.tag });
      // Anyone who confirmed while Q was away is given the role now. Only grants: a role an admin gave by hand stays.
      if (config.membership) settle(config.membership).catch((error) => console.error(JSON.stringify({ event: 'error', message: String(error) })));
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
          // One sentence typed in pieces reads as one sentence: joined with spaces, not line breaks.
          const text = batch.map((m) => m.content.replaceAll(`<@${me}>`, '').trim()).filter(Boolean).join(' ');
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
              let first: Message | undefined;
              for (const payload of payloads(reply, LIMIT)) first ??= await message.reply(send(payload));
              // The improvement loop: a refusal becomes a gap; every delivery is kept for an approval to find.
              if (first) handlers.delivered?.({ questionUrl: message.url, sentUrl: first.url, question: text, channelId: message.channelId, authorId: message.author.id, reply }).catch(failed);
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

    // What is deleted or changed on Discord is deleted or changed in Q's memory: Q never cites text its author took back.
    const failed = (error: unknown) => console.error(JSON.stringify({ event: 'error', message: String(error) }));
    const known = (message: Message | PartialMessage): Message | undefined => (message.partial ? undefined : message);
    const withdraw = async (message: Message | PartialMessage) => {
      if (message.author?.bot) return 0;
      const before = known(message);
      return handlers.withdraw(message.url, before && observed(before));
    };
    client.on(Events.MessageDelete, (message) => {
      withdraw(message).then((removed) => log('withdrawn', { reason: 'deleted', removed }), failed);
    });
    client.on(Events.MessageBulkDelete, (messages) => {
      Promise.all([...messages.values()].map(withdraw)).then((r) => log('withdrawn', { reason: 'deleted', removed: r.reduce((a, b) => a + b, 0) }), failed);
    });
    client.on(Events.MessageUpdate, async (old, updated) => {
      try {
        // An embed or a pin also arrives as an update; only an edit changes the text.
        const message = updated.partial ? await updated.fetch() : updated;
        if (message.author.bot || !message.editedTimestamp || (!old.partial && old.content === message.content)) return;
        const removed = await withdraw(old);
        log('withdrawn', { reason: 'edited', removed, decision: await handlers.observe(observed(message)) });
      } catch (error) {
        failed(error);
      }
    });
    client.on(Events.ThreadDelete, (thread) => {
      handlers.forgetChannel(thread.id).then((removed) => log('withdrawn', { reason: 'thread deleted', removed }), failed);
    });
    client.on(Events.ChannelDelete, (channel) => {
      handlers.forgetChannel(channel.id).then((removed) => log('withdrawn', { reason: 'channel deleted', removed }), failed);
    });

    // The rules reaction role: confirming the rules with the emoji gives the member role, withdrawing it takes it back.
    // The adapter reports the facts; the kernel decides (18); the adapter obeys.
    const rules = config.membership;
    const react = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, added: boolean) => {
      // A reaction on an answer Q sent, or on a member's reply to one: a signal for the improvement loop (decision 26).
      const on = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const onAgent = on.author?.id === client.user!.id;
      if (added && handlers.react && reaction.message.id !== rules?.message) {
        const reactor = user.partial ? await user.fetch() : user;
        log('signal', { decision: await handlers.react(on.url, reaction.emoji.name, !reactor.bot, reactor.id) });
        if (onAgent) return;
      }
      if (!rules) return;
      const onRules = reaction.message.id === rules.message && reaction.emoji.name === rules.emoji;
      const human = !(user.partial ? await user.fetch() : user).bot;
      const decision = await handlers.membership(onRules, human, added);
      if (decision === 'none') return;
      const member = await (await client.guilds.fetch(rules.guild)).members.fetch(user.id);
      if (decision === 'grant') await member.roles.add(rules.role, 'Confirmed the rules');
      else await member.roles.remove(rules.role, 'Withdrew the rules confirmation');
      log('membership', { decision, user: user.id });
    };
    client.on(Events.MessageReactionAdd, (reaction, user) => { react(reaction, user, true).catch(failed); });
    client.on(Events.MessageReactionRemove, (reaction, user) => { react(reaction, user, false).catch(failed); });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      // Forgetting is between the author and the agent; everything else is answered in the open.
      // Forgetting is between the author and the agent, and /improve can quote members' questions to an admin:
      // both are answered to the one who asked only. Everything else is answered in the open.
      await interaction.deferReply({ ephemeral: ['forget-me', 'improve', 'feedback', 'open'].includes(interaction.commandName) });
      try {
        const reply = await handlers.handle({
          channel: facts(interaction.channel as Message['channel'] | null),
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          authorId: interaction.user.id,
          role: role(interaction.member as GuildMember | null),
          trigger: 'slash',
          command: interaction.commandName as CommandName,
          text: interaction.options.getString('question') ?? interaction.options.getString('text') ?? interaction.options.getString('prompt') ?? '',
          options: { kind: interaction.options.getString('kind') ?? '' },
          status: (text) => { interaction.editReply(text).catch(() => {}); },
        });
        const [first, ...rest] = reply ? payloads(reply, LIMIT) : [{ content: 'No reply in this channel.' }];
        const sent = await interaction.editReply(send(first));
        if (reply && interaction.commandName === 'ask') handlers.delivered?.({ sentUrl: sent.url, question: interaction.options.getString('question') ?? '', channelId: interaction.channelId, authorId: interaction.user.id, reply }).catch(() => {});
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
    for (const guild of (await client.guilds.fetch()).values()) channels.push(...(await conversations(await guild.fetch())));
    for (const channel of channels) {
      if (!channel.isTextBased() || !('messages' in channel)) continue;
      const id = channel.id;
      let seen = 0, indexed = 0;
      try {
        for (;;) {
          const page = await channel.messages.fetch({ limit: 100, ...(cursors[id] ? { before: cursors[id] } : {}) });
          if (page.size === 0) break;
          for (const message of page.values()) {
            seen++;
            if ((await observe(observed(message))) === 'index') indexed++;
          }
          cursors[id] = page.last()!.id;
          await writeFile(config.backfillFile, JSON.stringify(cursors));
          log('backfill', { channel: id, name: channel.name, seen, indexed });
        }
      } catch (error) {
        // A channel Q may not read is skipped, not fatal: the rest of the server is still read.
        log('backfill-skipped', { channel: id, name: channel.name, reason: String(error) });
      }
    }
    await client.destroy();
  }

  /**
   * Every place a conversation happens in a server: its channels, every active thread, and every public archived
   * thread, which is where each forum post lives. Private threads are restricted, and the kernel denies them anyway.
   */
  async function conversations(guild: Guild) {
    const channels = [...(await guild.channels.fetch()).values()].filter((c) => c !== null);
    const threads = [...(await guild.channels.fetchActiveThreads()).threads.values()];
    for (const parent of channels) {
      if (!('threads' in parent)) continue;
      let before: string | undefined;
      try {
        for (;;) {
          const page = await parent.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) });
          threads.push(...page.threads.values());
          const last = page.threads.last();
          if (!page.hasMore || !last?.archiveTimestamp) break;
          before = new Date(last.archiveTimestamp).toISOString();
        }
      } catch (error) {
        log('backfill-skipped', { channel: parent.id, name: parent.name, reason: String(error) });
      }
    }
    log('backfill-plan', { guild: guild.name, channels: channels.length, threads: threads.length });
    return [...channels, ...threads];
  }

  const channelName = (id: string) => {
    const channel = client.channels.cache.get(id);
    return channel && 'name' in channel && channel.name ? channel.name : undefined;
  };

  /** Post a message Q writes on its own (the admin digest), split under Discord's limit, mentioning no one. */
  const post = async (channelId: string, text: string) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('send' in channel)) throw new Error(`cannot post to ${channelId}`);
    for (const payload of payloads({ text, decision: 'allowed', citations: [], delivery: text.length > LIMIT ? 'split' : 'send' }, LIMIT)) await channel.send(send(payload));
  };

  return { start, backfill, channelName, post };
}
