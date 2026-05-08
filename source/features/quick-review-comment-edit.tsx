import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import PencilIcon from 'octicons-plain-react/Pencil';
import {$optional} from 'select-dom';

import features from '../feature-manager.js';
import observe from '../helpers/selector-observer.js';

const CLASS = 'rgh-quick-review-comment-edit-button';

async function onClick(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
	event.preventDefault();
	event.stopPropagation();

	const button = event.currentTarget;
	const rightSide = button.closest<HTMLElement>('[data-testid="comment-header-right-side-items"]');
	if (!rightSide) {
		return;
	}

	const kebab = $optional<HTMLButtonElement>('[data-testid="comment-header-hamburger"]', rightSide);
	if (!kebab) {
		return;
	}

	kebab.click();

	const menu = await waitForMenu(kebab);
	if (!menu) {
		return;
	}

	const editItem = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
		.find(item => item.textContent?.trim().toLowerCase() === 'edit');

	if (editItem) {
		editItem.click();
	} else {
		kebab.click();
	}
}

async function waitForMenu(kebab: HTMLButtonElement): Promise<HTMLElement | undefined> {
	const selector = `[role="menu"][aria-labelledby="${CSS.escape(kebab.id)}"]`;
	for (let i = 0; i < 20; i++) {
		const menu = $optional<HTMLElement>(selector);
		if (menu) {
			return menu;
		}

		await new Promise(resolve => {
			setTimeout(resolve, 25);
		});
	}

	return undefined;
}

function addEditButton(rightSide: HTMLElement): void {
	if (rightSide.querySelector(`.${CLASS}`)) {
		return;
	}

	if (!rightSide.closest('[data-marker-navigation-comment-thread-id]')) {
		return;
	}

	const kebab = $optional<HTMLButtonElement>('[data-testid="comment-header-hamburger"]', rightSide);
	if (!kebab?.parentElement) {
		return;
	}

	kebab.parentElement.before(
		<button
			type="button"
			className={CLASS}
			aria-label="Edit comment"
			style={{
				background: 'none',
				border: 'none',
				cursor: 'pointer',
				padding: '4px',
				color: 'var(--fgColor-muted)',
				display: 'inline-flex',
				alignItems: 'center',
			}}
			onClick={onClick}
		>
			<PencilIcon />
		</button>,
	);
}

function init(signal: AbortSignal): void {
	observe('[data-testid="comment-header-right-side-items"]', addEditButton, {signal});
}

void features.add(import.meta.url, {
	asLongAs: [
		pageDetect.isLoggedIn,
	],
	include: [
		pageDetect.isPRConversation,
		pageDetect.isPRFiles,
	],
	init,
});

/*
Test URLs:

- https://github.com/refined-github/sandbox/pull/31/files
*/
