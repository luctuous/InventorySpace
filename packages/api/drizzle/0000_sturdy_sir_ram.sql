CREATE TABLE `analogous` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analogous_human_id_unique` ON `analogous` (`human_id`);--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`min_stock_threshold` real,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concepts_human_id_unique` ON `concepts` (`human_id`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_human_id` text,
	`action` text NOT NULL,
	`field_changed` text,
	`value_before` text,
	`value_after` text,
	`notes` text,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_entity_idx` ON `history` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `history_created_idx` ON `history` (`created_at`);--> statement-breakpoint
CREATE TABLE `id_registry` (
	`prefix` text PRIMARY KEY NOT NULL,
	`letter_part` text NOT NULL,
	`number_part` integer NOT NULL,
	`last_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`type_id` text NOT NULL,
	`variant_id` text,
	`analogous_id` text,
	`concept_id` text,
	`location_id` text,
	`status` text NOT NULL,
	`quantity_initial` real,
	`quantity_remaining` real,
	`unit` text,
	`price_amount` integer,
	`price_currency` text,
	`price_locked` integer DEFAULT false NOT NULL,
	`serial_number` text,
	`batch_number` text,
	`custom_fields` text DEFAULT '{}' NOT NULL,
	`received_at` integer,
	`opened_at` integer,
	`depleted_at` integer,
	`notes` text,
	`created_by` text,
	`lot_id` text,
	`lot_line_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`type_id`) REFERENCES `types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analogous_id`) REFERENCES `analogous`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_human_id_unique` ON `items` (`human_id`);--> statement-breakpoint
CREATE INDEX `items_concept_status_idx` ON `items` (`concept_id`,`status`);--> statement-breakpoint
CREATE INDEX `items_location_idx` ON `items` (`location_id`);--> statement-breakpoint
CREATE INDEX `items_variant_idx` ON `items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`level` text NOT NULL,
	`name` text,
	`parent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `locations_code_unique` ON `locations` (`code`);--> statement-breakpoint
CREATE TABLE `types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`human_id_prefix` text NOT NULL,
	`valid_statuses` text NOT NULL,
	`tracks_quantity` integer NOT NULL,
	`field_definitions` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `types_key_unique` ON `types` (`key`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`analogous_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`type_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`supplier` text,
	`catalog_ref` text,
	`format` text,
	`pack_size` real,
	`pack_unit` text,
	`purity` text,
	`concentration` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`analogous_id`) REFERENCES `analogous`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`type_id`) REFERENCES `types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_human_id_unique` ON `variants` (`human_id`);