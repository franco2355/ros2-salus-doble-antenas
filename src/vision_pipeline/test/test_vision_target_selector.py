from types import SimpleNamespace

from vision_pipeline.vision_target_selector import select_target


def _hypothesis(label: str, score: float):
    return SimpleNamespace(hypothesis=SimpleNamespace(class_id=label, score=score))


def _detection(label: str, score: float, *, detection_id: str = 'det', cx: float = 320.0):
    return SimpleNamespace(
        id=detection_id,
        results=[_hypothesis(label, score)],
        bbox=SimpleNamespace(
            center=SimpleNamespace(position=SimpleNamespace(x=float(cx), y=120.0)),
            size_x=100.0,
            size_y=80.0,
        ),
    )


def _detection_array(*detections):
    return SimpleNamespace(detections=list(detections))


def test_select_target_uses_highest_score_without_preferences() -> None:
    selected = select_target(
        _detection_array(
            _detection('person', 0.61, detection_id='person_0'),
            _detection('dog', 0.87, detection_id='dog_0'),
        ),
        preferred_labels=(),
        min_score=0.40,
        fallback_to_any_label=True,
        image_width=640,
        image_height=480,
    )

    assert selected is not None
    assert selected.label == 'dog'
    assert selected.detection_id == 'dog_0'
    assert selected.center_x_norm == 0.5


def test_select_target_prefers_configured_label() -> None:
    selected = select_target(
        _detection_array(
            _detection('dog', 0.92, detection_id='dog_0'),
            _detection('person', 0.66, detection_id='person_0'),
        ),
        preferred_labels=('person',),
        min_score=0.40,
        fallback_to_any_label=True,
        image_width=640,
        image_height=480,
    )

    assert selected is not None
    assert selected.label == 'person'
    assert selected.detection_id == 'person_0'


def test_select_target_can_reject_non_preferred_labels() -> None:
    selected = select_target(
        _detection_array(_detection('dog', 0.92, detection_id='dog_0')),
        preferred_labels=('person',),
        min_score=0.40,
        fallback_to_any_label=False,
        image_width=640,
        image_height=480,
    )

    assert selected is None
