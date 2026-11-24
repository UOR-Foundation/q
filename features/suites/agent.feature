Feature: agent

  The decisions of the UOR Discord agent, in app/src/Policy.lex.tex: what it may
  read, index, answer, cite, store and delete. The host asks before every effect
  and obeys the answer.

  @DA-01 @build
  Scenario: A channel is readable exactly when it is a text or forum channel, visible to everyone, labeled public, installed by an admin, with the Message Content intent granted
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.readPermitOnly and Policy.readPermitWhen
    Then permit is answered exactly for a public, labeled text or forum channel with an admin install and the intent granted
    And prism-code build replays a direct message, a voice channel, a restricted channel, an excluded channel and a non-admin install, each answered deny

  @DA-02 @build
  Scenario: A message is indexed only when its channel is readable, it is a person's conversation rather than a bot's message or a request to the agent, and its author has not opted out
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.indexAdmitOnly and Policy.noRequestIndexed
    Then index is answered only for a readable channel, a person's conversation and no opt-out
    And prism-code build replays an opted-out author, a bot author and a request to the agent, each answered skip

  @DA-03 @build
  Scenario: The agent replies only to a mention, a reply to itself or a slash command, in a text or forum channel visible to everyone, and never in a direct message
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.replyOnlyWhenInvited
    Then reply is answered only with a trigger, in a text or forum channel visible to everyone
    And prism-code build replays a direct message and a message with no trigger, each answered silent

  @DA-04 @build @rejects
  Scenario: No reindex or forget-channel command is allowed without the admin role, and forget-me is always allowed
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.adminNeedsRole and Policy.forgetMeAlways
    Then reindex and forget-channel are allowed only with the admin role, and forget-me always
    And prism-code build replays reindex and forget-channel from a member, each answered not authorized

  @DA-05 @build @rejects
  Scenario: A request is allowed only while the user counter and the channel counter are each under their limit
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.rateUnderBothLimits
    Then allowed is answered only while both counters are under their limits
    And prism-code build replays a user at the limit and a channel at the limit, each answered rate limited

  @DA-06 @build @rejects
  Scenario: No answer is sent with zero citations, and only the high score band is answered without a low-confidence notice
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.noUncitedAnswer and Policy.mediumCarriesNotice
    Then zero citations is never answered, and a medium band always carries the notice
    And prism-code build replays zero citations and a low band, each answered not grounded

  @DA-07 @build
  Scenario: An answer resting on an open claim is labelled open, and an answer is labelled build only when every claim it rests on is build
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.openStaysOpen and Policy.builtNeedsBuilt
    Then the answer level is the weakest level among the claims it rests on
    And prism-code build replays build with some-true answered some-true, and some-true with open answered open

  @DA-08 @build
  Scenario: Of two conflicting sources the preferred one is never the less trusted, in the order community, website, GitHub, Discord
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.preferredIsMostTrusted
    Then the preferred source is at least as trusted as each of the two
    And prism-code build replays community against Discord answered community

  @DA-09 @build
  Scenario: A forget request always deletes, and without one nothing within its age limit is deleted
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.forgetDeletes and Policy.keepsWithinLimit
    Then a forget request deletes whatever the class or age, and an item within its limit is kept
    And prism-code build replays an item one day past its limit answered delete, and one at its limit answered keep

  @DA-10 @build
  Scenario: An item is cited only when it has a label, its recomputed label matched and it is not revoked
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.citeOnlyVerified
    Then cite is answered only for a labelled, verified, unrevoked item
    And prism-code build replays an unverified item and a revoked item, each answered drop

  @DA-11 @build
  Scenario: No Discord item is ever assigned the public namespace
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.discordPrivate
    Then a Discord item is answered private
    And prism-code build replays community, website and GitHub answered public, and Discord answered private

  @DA-13 @open
  Scenario: The agent's read policy answers each of the 96 read requests as uor-discord-read does in the community's signed holo, measured at every start, and the agent does not start otherwise
    Given the community holo, pinned by its BLAKE3 label and its provenance verified against the community's Pages workflow
    When the host starts and asks both holos every one of the 96 read requests
    Then it starts only when every answer is the same
    And the host test plants one differing answer and the check names exactly that request

  @DA-14 @open
  Scenario: A community decision in an answer is what the community's signed holo answered, asked only when every input was read from the question
    Given a question a community decision app answers
    When the language model reads the app's inputs from the question
    Then the community holo is asked only when every input is one the app's prompt allows, and the answer names the app, the commit and the holo
    And an input the question does not state is named back to the reader, and the holo is not asked

  @DA-15 @open
  Scenario: Every question the agent answers or refuses leaves a context record and an answer record named by their BLAKE3 kappa labels, and an event with no text, author or label of either
    Given a question that is answered and one that is refused
    When the pipeline handles each
    Then each leaves a uor-agent/context/1 record and a uor-agent/answer/1 record naming it, linked by derived-from, evidence-provenance and certified-by
    And each emits one CloudEvents 1.0 event whose id is the label of its own content and which holds no question, author or record label

  @DA-16 @build
  Scenario: Access control follows LangBot's: under a whitelist only a listed session continues, and under a blacklist a listed session never does
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.whitelistOnlyListed and Policy.blacklistNeverListed
    Then continue is answered under a whitelist only for a listed session, and under a blacklist only for an unlisted one
    And prism-code build replays an unlisted session under a whitelist and a listed one under a blacklist, each answered ignore

  @DA-17 @build @rejects
  Scenario: Content filtering follows LangBot's: in scope, blocked content always interrupts, and masked content is never passed on unmasked
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.blockInterrupts and Policy.maskedNeverPlain
    Then incoming content that is masked or blocked interrupts, outgoing content that is blocked interrupts and masked goes out masked, and a stage out of scope continues
    And prism-code build replays blocked content incoming and outgoing, each answered interrupt

  @DA-18 @build
  Scenario: A reply longer than one Discord message is never sent as one, and a reply longer than five is never split into messages
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.neverOverLimit and Policy.neverFlood
    Then send is answered only for a reply that fits one message, and a reply past five messages is answered file
    And prism-code build replays a reply past five messages under the split strategy, answered file

  @DA-19 @build @rejects
  Scenario: A tool is called only on an allowlisted MCP server, and a tool that writes only for the admin role
    Given the policy model in app/src/Policy.lex.tex
    When prism-code check has Lean's kernel prove Policy.toolGuard
    Then call is answered only for an allowlisted server, and for a tool that writes only with the admin role
    And prism-code build replays a writing tool for a member and any tool on a server not allowlisted, each answered refuse

  @DA-20 @open
  Scenario: The agent runs only a kernel whose exact bytes this repository's holo workflow signed from a commit on main, checked at every start, unless an operator turns the check off
    Given the kernel holo the host is about to run
    When the host fetches GitHub's attestations for its SHA-256 and verifies them with Sigstore against .github/workflows/holo.yml on main
    Then it starts only when a verified provenance names these bytes, and records that commit in every context record
    And bytes nobody signed are refused, and the host tests refuse the real bundles for another signer, other bytes and another repository
