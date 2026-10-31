import { findBestMove } from './bot.js';

self.onmessage = ({data}) => {
  const {id, state, level} = data;
  try {
    self.postMessage({id, ...findBestMove(state, level)});
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
};
