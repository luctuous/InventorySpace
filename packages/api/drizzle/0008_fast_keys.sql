CREATE TABLE `fast_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chord` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fast_keys_user_id_unique` ON `fast_keys` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fast_keys_chord_unique` ON `fast_keys` (`chord`);