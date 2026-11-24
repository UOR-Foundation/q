Feature: contract

  The request contract of the agent kernel, in app/src/Contract.lex.tex: eight
  bytes, one decision and seven facts, answered with one decision as text.

  @DA-12 @build @rejects
  Scenario: The agent answers invalid request to a request that is not exactly eight bytes
    Given the contract model in app/src/Contract.lex.tex
    When prism-code check has Lean's kernel prove Contract.accepts_exactly_a_request
    Then a request is accepted exactly when it is eight bytes, one decision and seven facts
    And prism-code build replays requests of 0, 7 and 9 bytes and unknown decisions, each answered invalid request
