CREATE TABLE `assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`crew_id` integer NOT NULL,
	`skill` text NOT NULL,
	`scope` text NOT NULL,
	`agent_type` text NOT NULL,
	`issue` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`crew_id`) REFERENCES `crew`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignments_crew` ON `assignments` (`crew_id`);--> statement-breakpoint
CREATE TABLE `crew` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`name` text NOT NULL,
	`agent_type` text NOT NULL,
	`pane_id` text,
	`worktree_path` text,
	`branch` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crew_session_name` ON `crew` (`session_key`,`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`assignment_id` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`report_path` text,
	`pr_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_assignment` ON `events` (`assignment_id`);