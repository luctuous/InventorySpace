CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_human_id_unique` ON `suppliers` (`human_id`);--> statement-breakpoint
ALTER TABLE `lots` ADD `supplier_id` text REFERENCES suppliers(id);--> statement-breakpoint

-- Hand-added below: existing lots keep their supplier. One row per distinct
-- name already typed, matched case-insensitively — which is the whole point of
-- promoting suppliers to an entity.
INSERT INTO `suppliers` (`id`, `human_id`, `name`, `created_at`, `updated_at`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
	substr(lower(hex(randomblob(2))), 2) || '-a' ||
	substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	'SUP' || substr('000' || CAST(ROW_NUMBER() OVER (ORDER BY min(`rowid`)) AS TEXT), -3, 3),
	trim(`supplier`),
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `lots`
WHERE `supplier` IS NOT NULL AND trim(`supplier`) != ''
GROUP BY lower(trim(`supplier`));--> statement-breakpoint

UPDATE `lots` SET `supplier_id` = (
	SELECT `s`.`id` FROM `suppliers` `s`
	WHERE lower(`s`.`name`) = lower(trim(`lots`.`supplier`))
) WHERE `supplier` IS NOT NULL AND trim(`supplier`) != '';--> statement-breakpoint

-- Keep the human-id counter in step so the next SUP number cannot collide.
INSERT INTO `id_registry` (`prefix`, `letter_part`, `number_part`, `last_id`)
SELECT 'SUP', '', count(*), 'SUP' || substr('000' || CAST(count(*) AS TEXT), -3, 3)
FROM `suppliers` HAVING count(*) > 0;