import { X } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import type { Track } from "../../types";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import "./QueuePanel.css";
import "./TrackDetailsPanel.css";

interface Props {
	track: Track;
	onClose: () => void;
}

export default function TrackDetailsPanel({ track, onClose }: Props) {
	const isHome = useUiStore((state) => state.activeSection === "home");

	return (
		<aside
			className={`queue-panel track-details-panel-shell${isHome ? " is-home-overlay" : ""}`}
		>
			<div className="queue-header">
				<div className="queue-title-group">
					<h2>Track Details</h2>
				</div>
				<button
					className="icon-btn"
					onClick={onClose}
					title="Close"
					aria-label="Close track details"
				>
					<X size={20} />
				</button>
			</div>
			<TrackMetadataModal
				track={track}
				onClose={onClose}
				presentation="panel"
			/>
		</aside>
	);
}
