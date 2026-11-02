export const pagesOrigin = 'https://seasonalerror.github.io';
const roomHost = 'https://riftbound-chess-arena.nimeesh16-2007.chatgpt.site';

export function roomApiBase(origin) {
  return (origin === pagesOrigin ? roomHost : '') + '/api/rooms';
}
