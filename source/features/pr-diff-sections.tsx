import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';

import features from '../feature-manager.js';
import LoadingIcon from '../github-helpers/icon-loading.js';
import {buildRepoUrl, getConversationNumber} from '../github-helpers/index.js';
import observe from '../helpers/selector-observer.js';

type Section = 'src' | 'frontend' | 'templates' | 'config' | 'translations' | 'docs' | 'tests' | 'migrations' | 'generated';
type DiffSummary = {path: string; linesAdded: number; linesDeleted: number; isVendored: boolean};
type Totals = {files: number; additions: number; deletions: number};

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
		const totals = sections.get(section) ?? {files: 0, additions: 0, deletions: 0};
		totals.files++;
		totals.additions += file.linesAdded;
		totals.deletions += file.linesDeleted;
		sections.set(section, totals);
	}

	return sections;
}

const maxRowsPerColumn = 3;

function getTable(sections: Map<Section, Totals>): HTMLElement | undefined {
	const allLines = sections.values().reduce((sum, {additions, deletions}) => sum + additions + deletions, 0) || 1;
	const changed = (section: Section): number => {
		const totals = sections.get(section);
		return totals ? totals.additions + totals.deletions : 0;
	};

	const present = sectionOrder
		.filter(section => changed(section) > 0)
		.toSorted((a, b) => changed(b) - changed(a));
	if (present.length === 0) {
		return undefined;
	}

	const columns: Section[][] = [];
	const perColumn = Math.ceil(present.length / Math.ceil(present.length / maxRowsPerColumn));
	for (let index = 0; index < present.length; index += perColumn) {
		columns.push(present.slice(index, index + perColumn));
	}

	return (
		<div className="rgh-pr-diff-sections d-flex flex-items-start ml-3 text-bold" style={{
			fontSize: '10px', lineHeight: 1.1, alignSelf: 'center', marginTop: '-8px',
		}}>
			{columns.map((column, index) => (
				<table className={index > 0 ? 'ml-3' : ''}>
					<tbody>
						{column.map(section => {
							const {files, additions, deletions} = sections.get(section)!;
							const share = Math.round(((additions + deletions) / allLines) * 100);
							return (
								<tr title={`${files} ${files === 1 ? 'file' : 'files'}, ${share}% of changed lines`}>
									<td className="pr-2 color-fg-muted text-normal">{section}</td>
									<td className="pr-1 fgColor-success text-right">+{additions}</td>
									<td className="fgColor-danger text-right">−{deletions}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			))}
		</div>
	);
}

const cache = new Map<string, Promise<Map<Section, Totals>>>();

async function init(signal: AbortSignal): Promise<void> {
	observe([
		'#diffstat',
		'[class*="rightContentWrapper"] .d-flex.flex-items-center.gap-1:has(> [class*="fgColor-success"], > [class*="fgColor-danger"])',
	], async diffstat => {
		// GitHub swaps PRs without a page load, so the header may still hold the previous PR's table
		for (const stale of diffstat.parentElement!.querySelectorAll('.rgh-pr-diff-sections')) {
			stale.remove();
		}

		const pullRequestUrl = buildRepoUrl('pull', getConversationNumber()!);
		if (!cache.has(pullRequestUrl)) {
			cache.set(pullRequestUrl, fetchSections());
		}

		const spinner = <span className="rgh-pr-diff-sections ml-3 d-flex flex-items-center"><LoadingIcon /></span>;
		diffstat.after(spinner);
		try {
			const table = getTable(await cache.get(pullRequestUrl)!);
			if (table) {
				spinner.replaceWith(table);
			} else {
				spinner.remove();
			}
		} catch (error) {
			cache.delete(pullRequestUrl);
			spinner.remove();
			throw error;
		}
	}, {signal});
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
