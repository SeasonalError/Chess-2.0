CREATE TABLE `rooms` (
  `code` text PRIMARY KEY NOT NULL,
  `white_hash` text NOT NULL,
  `black_hash` text,
  `revision` integer NOT NULL,
  `state` text NOT NULL,
  `log` text NOT NULL,
  `outcome` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_white_hash_unique` ON `rooms` (`white_hash`);
