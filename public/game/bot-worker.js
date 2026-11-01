import { findBestMove } from './bot.js';

self.onmessage = ({data}) => {
  const {id, state, level, wildcard} = data;
  try {
    self.postMessage({id, ...findBestMove(state, level, {wildcard})});
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
};
