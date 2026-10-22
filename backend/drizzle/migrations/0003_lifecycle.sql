-- Hand-edited: drizzle's table rebuild would drop `repositories`, and D1 can't switch foreign keys
-- off, so activity's ON DELETE SET NULL would unlink every activity row. Columns are added in place.
ALTER TABLE `repositories` ADD `status` text DEFAULT 'ready' NOT NULL CONSTRAINT "repositories_status" CHECK(status in ('provisioning', 'ready', 'failed', 'deleting'));--> statement-breakpoint
ALTER TABLE `repositories` ADD `status_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `storage_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `repositories` SET `status_at` = `updated_at`, `storage_key` = 'repositories/' || `id` || '/';--> statement-breakpoint
CREATE INDEX `repositories_status` ON `repositories` (`status`,`status_at`);
