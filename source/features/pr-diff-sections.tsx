import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';

import features from '../feature-manager.js';
import {buildRepoUrl, getConversationNumber} from '../github-helpers/index.js';
import observe from '../helpers/selector-observer.js';

type Section = 'Code' | 'Tests' | 'Docs' | 'Config/CI' | 'Migrations' | 'Generated';
type DiffSummary = {path: string; linesAdded: number; linesDeleted: number; isVendored: boolean};
type Totals = {files: number; additions: number; deletions: number};

const sectionOrder: Section[] = ['Code', 'Tests', 'Docs', 'Config/CI', 'Migrations', 'Generated'];

const heuristics: Array<[Section, RegExp]> = [
	['Generated', /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum)$/],
	['Generated', /\.min\.(js|css)$|(^|\/)(vendor|dist|generated)\//],
	['Tests', /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?|__snapshots__)\/|\.(test|spec)\.[^/]+$|Test\.php$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i],
	['Docs', /\.(md|mdx|rst|adoc)$|(^|\/)docs?\//i],
	['Migrations', /(^|\/)migrations?\//i],
	['Config/CI', /^\.github\/|(^|\/)\.[^/]+$|\.(ya?ml|json|toml|ini|neon|dist)$|(^|\/)(Dockerfile|Makefile|compose\.[^/]+)$/i],
];

function classify({path, isVendored}: DiffSummary): Section {
	if (isVendored) {
		return 'Generated';
	}

	// Undefined for plain source files
	return heuristics.find(([, pattern]) => pattern.test(path))?.[0] ?? 'Code';
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

const rowsPerColumn = 3;

function getTable(sections: Map<Section, Totals>): HTMLElement {
	const allLines = [...sections.values()].reduce((sum, {additions, deletions}) => sum + additions + deletions, 0) || 1;
	const present = sectionOrder.filter(section => sections.has(section));
	const columns: Section[][] = [];
	for (let index = 0; index < present.length; index += rowsPerColumn) {
		columns.push(present.slice(index, index + rowsPerColumn));
	}

	return (
		<div className="rgh-pr-diff-sections d-flex ml-3 text-bold" style={{
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
									<td className="pr-2 color-fg-muted text-normal">{section.toLowerCase()}</td>
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

async function init(signal: AbortSignal): Promise<void> {
	let sections: Promise<Map<Section, Totals>> | undefined;
	observe([
		'#diffstat',
		'[class*="rightContentWrapper"] .d-flex.flex-items-center.gap-1:has(> [class*="fgColor-success"], > [class*="fgColor-danger"])',
	], async diffstat => {
		sections ??= fetchSections();
		diffstat.after(getTable(await sections));
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
