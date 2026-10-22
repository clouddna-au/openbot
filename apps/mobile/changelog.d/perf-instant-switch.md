### Fixed

- Opening an agent chat shows its messages sooner after the app connects. Before, the app first
  sent task, routine and photo reads for every agent, and the chat waited behind them for up to
  20 seconds on a slow connection. The app now loads the latest messages of the agents in the
  background, and sends at most two task, routine or photo reads at a time.
