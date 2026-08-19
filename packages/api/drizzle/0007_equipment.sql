CREATE TABLE `item_links` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_item_id` text NOT NULL,
	`child_item_id` text NOT NULL,
	`relation` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_links_parent_idx` ON `item_links` (`parent_item_id`);--> statement-breakpoint
CREATE INDEX `item_links_child_idx` ON `item_links` (`child_item_id`);--> statement-breakpoint
CREATE TABLE `maintenance_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'service' NOT NULL,
	`every_days` integer,
	`every_uses` integer,
	`uses_since_last` integer DEFAULT 0 NOT NULL,
	`last_done_at` integer,
	`next_due_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `maintenance_item_idx` ON `maintenance_plans` (`item_id`);--> statement-breakpoint
CREATE INDEX `maintenance_due_idx` ON `maintenance_plans` (`next_due_at`);--> statement-breakpoint
CREATE TABLE `maintenance_records` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`done_at` integer NOT NULL,
	`user_id` text,
	`uses_at_service` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `maintenance_plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `maintenance_records_plan_idx` ON `maintenance_records` (`plan_id`);