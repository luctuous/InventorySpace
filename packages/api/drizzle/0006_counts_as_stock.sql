ALTER TABLE `types` ADD `counts_as_stock` integer DEFAULT true NOT NULL;--> statement-breakpoint

-- Hand-added: the two types that were always wrong on Home. "0 gas
-- chromatographs in stock" is not a warning. Everything else keeps the
-- default, and any type can be switched either way in Types afterwards.
UPDATE `types` SET `counts_as_stock` = 0 WHERE `key` IN ('instrument', 'document');