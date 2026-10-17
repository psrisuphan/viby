import { useId } from "react";
import AccessibleDialog from "./AccessibleDialog";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export default function ConfirmDialog({
	title,
	description,
	confirmLabel,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const descriptionId = useId();

	return (
		<AccessibleDialog
			ariaLabel={title}
			ariaDescribedBy={descriptionId}
			overlayClassName="modal-overlay"
			contentClassName="modal-content glass-panel-heavy confirm-dialog"
			onClose={onCancel}
		>
			<h2>{title}</h2>
			<p id={descriptionId}>{description}</p>
			<div className="confirm-dialog-actions">
				<button type="button" className="btn btn-ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="btn btn-primary btn-danger" onClick={onConfirm}>
					{confirmLabel}
				</button>
			</div>
		</AccessibleDialog>
	);
}
