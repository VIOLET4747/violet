import { useEffect, useRef } from "react";

/**
 * 通用弹窗容器。
 *
 * 修过的坑：之前 mask 上直接 onClick=onClose，在输入框里拖选文字时，
 * mousedown 在 input、mouseup 落到遮罩上，浏览器把 click 派发给共同祖先（mask），
 * 弹窗会被误关。现在只有 pointerdown 与 click 的 target 都是遮罩本身才关闭。
 */
export function Modal({ onClose, wide = false, children }) {
	const downOnMask = useRef(false);

	useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			className="modal-mask"
			onPointerDown={(event) => {
				downOnMask.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				const shouldClose = downOnMask.current && event.target === event.currentTarget;
				downOnMask.current = false;
				if (shouldClose) onClose();
			}}
		>
			<div className={`modal${wide ? " wide" : ""}`} onClick={(event) => event.stopPropagation()}>
				{children}
			</div>
		</div>
	);
}
