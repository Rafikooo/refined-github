import './pr-diff-sections.css';

import cx from 'clsx';
import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import CheckCircleFillIcon from 'octicons-plain-react/CheckCircleFill';
import ChevronDownIcon from 'octicons-plain-react/ChevronDown';
import {$, $$optional, $optional, elementExists, closestElementOptional} from 'select-dom';

import features from '../feature-manager.js';
import {buildRepoUrl, getConversationNumber, visitAjaxedPage} from '../github-helpers/index.js';
import observe from '../helpers/selector-observer.js';

type Section = 'src' | 'frontend' | 'templates' | 'config' | 'translations' | 'docs' | 'tests' | 'migrations' | 'generated';
type DiffSummary = {
	path: string;
	pathDigest: string;
	linesAdded: number;
	linesDeleted: number;
	isVendored: boolean;
	markedAsViewed: boolean;
};
type Totals = {
	files: number;
	additions: number;
	deletions: number;
	digests: Set<string>;
	paths: string[];
	viewed: Set<string>;
};

const sectionOrder: Section[] = ['src', 'frontend', 'templates', 'config', 'translations', 'docs', 'tests', 'migrations', 'generated'];

const heuristics: Array<[Section, RegExp]> = [
	['generated', /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum)$/],
	['generated', /\.min\.(?:js|css)$|(?:^|\/)(?:vendor|dist|generated)\//],
	['tests', /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|__snapshots__)\/|\.(?:test|spec)\.[^/]+$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]+\.py$/i],
	['tests', /[\da-z]Test\.php$/],
	['docs', /\.(?:md|mdx|rst|adoc)$|(?:^|\/)docs?\//i],
	['migrations', /(?:^|\/)migrations?\//i],
	['translations', /(?:^|\/)(?:translations|locales?|i18n|lang)\//i],
	['templates', /(?:^|\/)templates\/|\.(?:twig|blade\.php|html\.erb|hbs)$/i],
	['frontend', /(?:^|\/)(?:frontend|assets)\/|\.(?:vue|svelte|css|scss|less)$/i],
	['config', /^\.github\/|(?:^|\/)\.[^/]+$|\.(?:ya?ml|json|toml|ini|neon|dist)$|(?:^|\/)(?:dockerfile|makefile|compose\.[^/]+)$/i],
];

function classify({path, isVendored}: DiffSummary): Section {
	if (isVendored) {
		return 'generated';
	}

	// Undefined for plain source files
	return heuristics.find(([, pattern]) => pattern.test(path))?.[0] ?? 'src';
}

// Same JSON the React "Files changed" tab loads, so it works with the session alone, no token
async function fetchSections(): Promise<Map<Section, Totals>> {
	const response = await fetch(buildRepoUrl('pull', getConversationNumber()!, 'files'), {
		headers: {Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
	});
	if (!response.ok) {
		throw new Error(`Files changed payload returned ${response.status}`);
	}

	const {payload} = await response.json();
	const files: DiffSummary[] = payload.pullRequestsChangesRoute.diffSummaries;

	const sections = new Map<Section, Totals>();
	for (const file of files) {
		const section = classify(file);
		const totals = sections.get(section) ?? {
			files: 0, additions: 0, deletions: 0, digests: new Set<string>(), paths: [], viewed: new Set<string>(),
		};
		totals.files++;
		totals.digests.add(file.pathDigest);
		totals.paths.push(file.path);
		if (file.markedAsViewed) {
			totals.viewed.add(file.pathDigest);
		}

		totals.additions += file.linesAdded;
		totals.deletions += file.linesDeleted;
		sections.set(section, totals);
	}

	return sections;
}

const cache = new Map<string, Promise<Map<Section, Totals>>>();
const pendingFilterKey = 'rgh-pr-diff-sections-filter';
const collapsedKey = 'rgh-pr-diff-sections-collapsed';
const fileToggle = '[class*="diffHeaderWrapper"] button:has(> .octicon-chevron-down, > .octicon-chevron-right)';

let activeFilter: {pullRequestUrl: string; section: Section; controller: AbortController} | undefined;
let resetController: AbortController | undefined;

function getPullRequestUrl(): string {
	return buildRepoUrl('pull', getConversationNumber()!);
}

async function getSections(): Promise<Map<Section, Totals>> {
	const pullRequestUrl = getPullRequestUrl();
	if (!cache.has(pullRequestUrl)) {
		cache.set(pullRequestUrl, fetchSections());
	}

	try {
		return await cache.get(pullRequestUrl)!;
	} catch (error) {
		cache.delete(pullRequestUrl);
		throw error;
	}
}

function getSortedSections(sections: Map<Section, Totals>): Section[] {
	const changed = (section: Section): number => {
		const totals = sections.get(section);
		return totals ? totals.additions + totals.deletions : 0;
	};

	return sectionOrder
		.filter(section => changed(section) > 0)
		.toSorted((a, b) => changed(b) - changed(a));
}

// Returns whether the item already was in the requested state
function setExpanded(toggle: HTMLElement | undefined, isExpanded: boolean, expanded: boolean): boolean {
	if (!toggle) {
		return false;
	}

	if (isExpanded === expanded) {
		return true;
	}

	toggle.click();
	return false;
}

function setFileExpanded(entry: HTMLElement, expanded: boolean): boolean {
	const toggle = $optional(fileToggle, entry);
	return setExpanded(toggle, elementExists('.octicon-chevron-down', toggle ?? entry), expanded);
}

function setFolderExpanded(folder: HTMLElement, expanded: boolean): boolean {
	const toggle = $optional('[class*="TreeView-item-toggle"]', folder);
	return setExpanded(toggle, folder.getAttribute('aria-expanded') === 'true', expanded);
}

function highlightActiveSection(): void {
	for (const element of $$optional('.rgh-pr-diff-sections [data-section]')) {
		// Undefined while no section filter is active
		const isActive = element.dataset.section === activeFilter?.section;
		element.classList.toggle('rgh-pr-diff-sections-active', isActive);
		element.classList.toggle('ActionListItem--navActive', isActive && element.tagName === 'LI');
	}
}

// Toggles clicked before React hydrates are ignored, while virtualized files and nested folders mount later.
// An item is left alone once it matches, so whatever the user toggles by hand stays that way.
function keepApplying(
	isFileWanted: (digest: string) => boolean,
	isFolderWanted: (path: string) => boolean,
	signal: AbortSignal,
): void {
	const settled = new WeakSet<HTMLElement>();
	const apply = (): void => {
		for (const entry of $$optional('div[class*="diffEntry"]:has(> [id^="diff-"])')) {
			const digest = $('[id^="diff-"]', entry).id.replace('diff-', '');
			if (!settled.has(entry) && setFileExpanded(entry, isFileWanted(digest))) {
				settled.add(entry);
			}
		}

		for (const folder of $$optional('#pr-file-tree [role="treeitem"][aria-expanded]')) {
			if (!settled.has(folder) && setFolderExpanded(folder, isFolderWanted(folder.id))) {
				settled.add(folder);
			}
		}
	};

	apply();
	const interval = setInterval(apply, 300);
	signal.addEventListener('abort', () => {
		clearInterval(interval);
	});
}

async function applyFilter(section: Section | undefined): Promise<void> {
	// Undefined while no section filter is active
	activeFilter?.controller.abort();
	// Undefined until the filter was first cleared
	resetController?.abort();
	activeFilter = undefined;

	if (!section) {
		resetController = new AbortController();
		keepApplying(() => true, () => true, resetController.signal);
		const {signal} = resetController;
		setTimeout(() => {
			if (!signal.aborted) {
				resetController!.abort();
			}
		}, 3000);
		highlightActiveSection();
		return;
	}

	const sections = await getSections();
	const {digests, paths} = sections.get(section)!;
	const controller = new AbortController();
	activeFilter = {pullRequestUrl: getPullRequestUrl(), section, controller};
	highlightActiveSection();
	keepApplying(
		digest => digests.has(digest),
		folder => paths.some(path => path.startsWith(`${folder}/`)),
		controller.signal,
	);
}

async function toggleFilter(section: Section): Promise<void> {
	// Undefined while no section filter is active
	const next = section === activeFilter?.section ? undefined : section;
	if (pageDetect.isPRFiles()) {
		await applyFilter(next);
		return;
	}

	if (next) {
		sessionStorage.setItem(pendingFilterKey, JSON.stringify({pullRequestUrl: getPullRequestUrl(), section: next}));
	}

	visitAjaxedPage(`${getPullRequestUrl()}/changes`);
}

function describe({files, additions, deletions}: Totals, allLines: number): string {
	const share = Math.round(((additions + deletions) / allLines) * 100);
	return `${files} ${files === 1 ? 'file' : 'files'}, ${share}% of changed lines`;
}

function countLines(sections: Map<Section, Totals>): number {
	return sections.values().reduce((sum, {additions, deletions}) => sum + additions + deletions, 0) || 1;
}

const maxRowsPerColumn = 3;

function getHeaderTable(sections: Map<Section, Totals>): HTMLElement | undefined {
	const present = getSortedSections(sections);
	if (present.length === 0) {
		return undefined;
	}

	const allLines = countLines(sections);
	const columns: Section[][] = [];
	const perColumn = Math.ceil(present.length / Math.ceil(present.length / maxRowsPerColumn));
	for (let index = 0; index < present.length; index += perColumn) {
		columns.push(present.slice(index, index + perColumn));
	}

	return (
		<div className="rgh-pr-diff-sections rgh-pr-diff-sections-header rgh-pr-diff-sections-fade d-flex flex-items-start ml-3 text-bold">
			{columns.map((column, index) => (
				<table className={index > 0 ? 'ml-3' : ''}>
					<tbody>
						{column.map(section => {
							const totals = sections.get(section)!;
							return (
								<tr
									data-section={section}
									title={`${describe(totals, allLines)}. Click to show only these files`}
									onClick={() => {
										void toggleFilter(section);
									}}
								>
									<td className="pr-2 color-fg-muted text-normal">{section}</td>
									<td className="pr-1 fgColor-success text-right">+{totals.additions}</td>
									<td className="fgColor-danger text-right">−{totals.deletions}</td>
									<td className="pl-1"><span className="rgh-pr-diff-sections-progress" data-section={section} data-compact /></td>
								</tr>
							);
						})}
					</tbody>
				</table>
			))}
		</div>
	);
}

function getSidebarList(sections: Map<Section, Totals>): HTMLElement | undefined {
	const present = getSortedSections(sections);
	if (present.length === 0) {
		return undefined;
	}

	const allLines = countLines(sections);
	// Sign plus the longest number, so every row lines up like a fixed-width printf column
	const additionsWidth = `${Math.max(...present.map(section => String(sections.get(section)!.additions).length)) + 1}ch`;
	const deletionsWidth = `${Math.max(...present.map(section => String(sections.get(section)!.deletions).length)) + 1}ch`;
	return (
		<details
			open={localStorage.getItem(collapsedKey) !== 'true'}
			className="rgh-pr-diff-sections rgh-pr-diff-sections-sidebar rgh-pr-diff-sections-fade details-reset tmp-pr-lg-3 pb-2 mb-2 border-bottom"
			onToggle={({currentTarget}) => {
				localStorage.setItem(collapsedKey, String(!(currentTarget).open));
			}}
		>
			<summary className="d-flex flex-items-center gap-1 px-2 py-1 rounded-2 f6 text-bold color-fg-muted">
				<ChevronDownIcon className="rgh-pr-diff-sections-chevron" />
				Sections
			</summary>
				<ul className="ActionListWrap ActionListWrap--inset">
					{present.map(section => {
						const totals = sections.get(section)!;
						return (
							<li className="ActionListItem" data-section={section}>
								<button
									type="button"
									className="ActionListContent ActionListContent--sizeSmall"
									title={`${describe(totals, allLines)}. Click to show only these files, click again to show all`}
									onClick={() => {
										void toggleFilter(section);
									}}
								>
									<span className="ActionListItem-label d-flex flex-items-center gap-2">
										{section}
										<span className="rgh-pr-diff-sections-progress d-inline-flex flex-items-center gap-1 f6 text-normal color-fg-muted" data-section={section} />
									</span>
									<span className="rgh-pr-diff-sections-numbers ActionListItem-visual ActionListItem-visual--trailing f6 text-bold">
										<span className="fgColor-success text-right" style={{minWidth: additionsWidth}}>+{totals.additions}</span>
										<span className="fgColor-danger text-right ml-1" style={{minWidth: deletionsWidth}}>−{totals.deletions}</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
		</details>
	);
}

const ringLength = 2 * Math.PI * 6;

function getProgressRing(fraction: number): SVGElement {
	// Dom-chef keeps camelCase props as attribute names, which SVG ignores, so strokes go through `style`
	return <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6" fill="none" style={{stroke: 'var(--borderColor-default)', strokeWidth: 2}} />
			<circle
				cx="8"
				cy="8"
				r="6"
				fill="none"
				transform="rotate(-90 8 8)"
				style={{
					stroke: 'var(--fgColor-done)',
					strokeWidth: 2,
					strokeDasharray: ringLength,
					strokeDashoffset: ringLength * (1 - fraction),
				}}
			/>
		</svg>;
}

function renderProgress(sections: Map<Section, Totals>): void {
	for (const element of $$optional('.rgh-pr-diff-sections-progress')) {
		const totals = sections.get(element.dataset.section as Section);
		if (!totals) {
			continue;
		}

		const isComplete = totals.viewed.size === totals.files;
		element.title = `${totals.viewed.size} / ${totals.files} viewed`;
		// Undefined in the header table, which sits outside any list item
		closestElementOptional('li', element)?.classList.toggle('rgh-pr-diff-sections-complete', isComplete);
		if (isComplete) {
			element.replaceChildren(<CheckCircleFillIcon className="fgColor-done" width={12} height={12} />);
		} else if ('compact' in element.dataset) {
			element.replaceChildren();
		} else {
			element.replaceChildren(getProgressRing(totals.viewed.size / totals.files), `${totals.viewed.size}/${totals.files}`);
		}
	}
}

// Picks up single clicks, alt-click batches and other features marking files as viewed
function syncViewedState(sections: Map<Section, Totals>, signal: AbortSignal): void {
	const sync = (): void => {
		let hasChanged = false;
		for (const entry of $$optional('div[class*="diffEntry"]:has(> [id^="diff-"])')) {
			const digest = $('[id^="diff-"]', entry).id.replace('diff-', '');
			const viewedButton = $$optional('[class*="diffHeaderWrapper"] button[aria-pressed]', entry)
				.find(button => button.textContent.includes('Viewed'));
			const totals = sections.values().find(({digests}) => digests.has(digest));
			if (!viewedButton || !totals) {
				continue;
			}

			const isViewed = viewedButton.getAttribute('aria-pressed') === 'true';
			if (isViewed === totals.viewed.has(digest)) {
				continue;
			}

			hasChanged = true;
			if (isViewed) {
				totals.viewed.add(digest);
			} else {
				totals.viewed.delete(digest);
			}
		}

		if (hasChanged) {
			renderProgress(sections);
		}
	};

	const interval = setInterval(sync, 1000);
	signal.addEventListener('abort', () => {
		clearInterval(interval);
	});
}

async function applyPendingFilter(): Promise<void> {
	const pending = sessionStorage.getItem(pendingFilterKey);
	if (!pending) {
		return;
	}

	sessionStorage.removeItem(pendingFilterKey);
	const {pullRequestUrl, section} = JSON.parse(pending) as {pullRequestUrl: string; section: Section};
	if (pullRequestUrl === getPullRequestUrl()) {
		await applyFilter(section);
	}
}

function getSkeleton(className: string, barHeight: string, widths: string[]): HTMLElement {
	return (
		<div className={cx('rgh-pr-diff-sections', className)}>
			{widths.map(width => <span className="SkeletonBox anim-pulse" style={{width, height: barHeight}} />)}
		</div>
	);
}

function removeLists(anchor: Element): void {
	for (const stale of $$optional(':scope > .rgh-pr-diff-sections', anchor.parentElement!)) {
		stale.remove();
	}
}

async function insert(
	anchor: Element,
	render: (sections: Map<Section, Totals>) => HTMLElement | undefined,
	skeleton: HTMLElement,
): Promise<void> {
	const pullRequestUrl = getPullRequestUrl();
	const existing = anchor.nextElementSibling;
	// Null when the anchor is the last child
	if (existing?.classList.contains('rgh-pr-diff-sections') && existing.getAttribute('data-pull-request-url') === pullRequestUrl) {
		return;
	}

	// GitHub swaps PRs without a page load, so the anchor may still hold the previous PR's list
	removeLists(anchor);
	skeleton.dataset.pullRequestUrl = pullRequestUrl;
	anchor.after(skeleton);
	try {
		const sections = await getSections();
		const element = render(sections);
		if (!element) {
			skeleton.remove();
			return;
		}

		element.dataset.pullRequestUrl = pullRequestUrl;
		skeleton.replaceWith(element);
		renderProgress(sections);
		highlightActiveSection();
	} catch (error) {
		skeleton.remove();
		throw error;
	}
}

const headerAnchor = [
	'#diffstat',
	'[class*="rightContentWrapper"] .d-flex.flex-items-center.gap-1:has(> [class*="fgColor-success"], > [class*="fgColor-danger"])',
] as const;
const sidebarAnchor = '#pr-file-tree > div:has(input)';

async function addHeaderTable(diffstat: Element): Promise<void> {
	// The sidebar list already shows the same numbers on the files tab
	if (pageDetect.isPRFiles()) {
		removeLists(diffstat);
		return;
	}

	await insert(diffstat, getHeaderTable, getSkeleton('rgh-pr-diff-sections-header-skeleton', '8px', ['72px', '60px', '66px']));
}

async function addSidebarList(filterRow: Element): Promise<void> {
	await insert(filterRow, getSidebarList, getSkeleton('rgh-pr-diff-sections-sidebar-skeleton', '16px', ['70%', '55%', '62%']));
}

async function init(signal: AbortSignal): Promise<void> {
	// Undefined while no section filter is active
	if (activeFilter && activeFilter.pullRequestUrl !== getPullRequestUrl()) {
		activeFilter.controller.abort();
		activeFilter = undefined;
	}

	// Switching tabs can keep the header mounted, and `observe` skips elements it has already seen
	for (const diffstat of $$optional(headerAnchor)) {
		void addHeaderTable(diffstat);
	}

	observe(headerAnchor, addHeaderTable, {signal});
	observe(sidebarAnchor, addSidebarList, {signal});

	if (!pageDetect.isPRFiles()) {
		return;
	}

	syncViewedState(await getSections(), signal);
	await applyPendingFilter();
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPR,
	],
	init,
});

/*

Test URLs:

https://github.com/refined-github/refined-github/pull/9369
https://github.com/refined-github/refined-github/pull/9369/files

*/
