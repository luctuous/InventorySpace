CREATE TABLE `action_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`quantity` real NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `action_lines_action_idx` ON `action_lines` (`action_id`,`valid_to`);--> statement-breakpoint
CREATE TABLE `action_records` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`occurred_at` integer NOT NULL,
	`user_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`log_line_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `action_records_occurred_idx` ON `action_records` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_human_id_unique` ON `actions` (`human_id`);--> statement-breakpoint
CREATE TABLE `log_event_defs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`shadow` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `log_event_defs_name_unique` ON `log_event_defs` (`name`);--> statement-breakpoint
CREATE TABLE `log_event_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`effects` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `log_event_defs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `log_event_versions_event_idx` ON `log_event_versions` (`event_id`,`valid_to`);--> statement-breakpoint
CREATE TABLE `log_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`line_hash` text NOT NULL,
	`raw` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`object_type` text,
	`object_id` text,
	`event_name` text,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `log_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `log_lines_line_hash_unique` ON `log_lines` (`line_hash`);--> statement-breakpoint
CREATE INDEX `log_lines_status_idx` ON `log_lines` (`status`);--> statement-breakpoint
CREATE INDEX `log_lines_event_idx` ON `log_lines` (`event_name`);--> statement-breakpoint
CREATE INDEX `log_lines_occurred_idx` ON `log_lines` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `log_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parser` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`cursor_offset` integer DEFAULT 0 NOT NULL,
	`last_line_at` integer,
	`last_polled_at` integer,
	`silence_minutes` integer DEFAULT 240 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `lot_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`ordered_variant_id` text NOT NULL,
	`ordered_quantity` real NOT NULL,
	`unit_price_amount` integer,
	`price_currency` text,
	`received_variant_id` text,
	`received_quantity` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expiry_date` integer,
	`location_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ordered_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lot_lines_lot_idx` ON `lot_lines` (`lot_id`);--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`supplier` text,
	`reference` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`ordered_at` integer,
	`received_at` integer,
	`notes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lots_human_id_unique` ON `lots` (`human_id`);--> statement-breakpoint
CREATE TABLE `occupancies` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`position` text,
	`sample_tag` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`unit_id`) REFERENCES `pool_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `occupancies_unit_idx` ON `occupancies` (`unit_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `occupancies_tag_idx` ON `occupancies` (`sample_tag`);--> statement-breakpoint
CREATE TABLE `pool_events` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`unit_id` text,
	`kind` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`note` text,
	`user_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `pool_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pool_events_pool_idx` ON `pool_events` (`pool_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pool_recounts` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`expected` integer NOT NULL,
	`counted` integer NOT NULL,
	`attrition` integer NOT NULL,
	`note` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pool_units` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`code` text NOT NULL,
	`state` text DEFAULT 'available' NOT NULL,
	`location_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pool_units_pool_code_idx` ON `pool_units` (`pool_id`,`code`);--> statement-breakpoint
CREATE TABLE `pools` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`name` text NOT NULL,
	`granularity` text NOT NULL,
	`concept_id` text,
	`available` integer DEFAULT 0 NOT NULL,
	`in_use` integer DEFAULT 0 NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`addressable` integer DEFAULT false NOT NULL,
	`slots_per_unit` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pools_human_id_unique` ON `pools` (`human_id`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`container_quantity` real NOT NULL,
	`theoretical_used` real NOT NULL,
	`unassigned` real NOT NULL,
	`opened_at` integer,
	`closed_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reconciliations_concept_idx` ON `reconciliations` (`concept_id`);--> statement-breakpoint
CREATE TABLE `request_supporters` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text,
	`urgency` text DEFAULT 'normal' NOT NULL,
	`hint_variant_id` text,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`lot_line_id` text,
	`requested_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hint_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_human_id_unique` ON `requests` (`human_id`);--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`);--> statement-breakpoint
CREATE INDEX `requests_concept_idx` ON `requests` (`concept_id`);--> statement-breakpoint
ALTER TABLE `concepts` ADD `tracking_level` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `concepts` ADD `seeded_monthly_rate` real;--> statement-breakpoint
ALTER TABLE `items` ADD `estimated_used` real DEFAULT 0 NOT NULL;