### Fixed

- A reply that an agent writes shows sooner. Before, the app read the full message queue again for
  each queue change notice from the computer, and these reads ran at the same time. The computer
  answers about one request at a time, so the chat read that holds the reply waited behind them.
  Now one queue read runs at a time, it goes after the chat read, and the app loads other chats
  only while no agent works.
