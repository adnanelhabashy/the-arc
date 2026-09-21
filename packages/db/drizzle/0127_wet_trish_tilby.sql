CREATE TABLE `thread_image_metadata` (
	`thread_id` text NOT NULL,
	`source` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`etag` text,
	PRIMARY KEY(`thread_id`, `source`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `origin_plugin_id` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `requested_by_initiator` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `requested_by_thread_id` text;