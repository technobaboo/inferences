use eframe::{App, NativeOptions};
use egui::{
    Color32, DragPanButtons, LayerId, Order, PointerButton, Pos2, Rect, Scene, Stroke, Ui, Vec2,
    ViewportBuilder,
};
use indexmap::IndexMap;
use mint::Point2;
use std::time::Duration;

fn main() -> Result<(), eframe::Error> {
    eframe::run_native(
        "Inferences",
        NativeOptions {
            viewport: ViewportBuilder::default()
                .with_min_inner_size([400.0, 300.0])
                .with_inner_size([512.0, 512.0]),
            ..Default::default()
        },
        Box::new(|cc| Ok(Box::new(InferencesApp::restore(cc)))),
    )
}
#[derive(Default, serde::Serialize, serde::Deserialize)]
pub struct IdCounter(u64);
impl IdCounter {
    pub fn new_id(&mut self) -> Id {
        let id = Id(self.0);
        self.0 += 1;
        id
    }
}

#[derive(
    Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub struct Id(u64);
#[derive(
    Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub struct TagId(u64);

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct Tag {
    name: String,
    color: Color32,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct Thing {
    name: String,
    color: Color32,
    position: Point2<f32>,
    #[serde(skip)]
    editor_pos: Option<Point2<f32>>,
    #[serde(default)]
    pinned: bool,
}
impl Thing {
    fn ui(&mut self, ui: &mut Ui, id: Id) -> bool {
        ui.painter().circle_stroke(
            self.position.into(),
            32.0,
            Stroke {
                width: 1.0,
                color: Color32::DEBUG_COLOR,
            },
        );
        true // to keep this alive
    }
}
#[derive(serde::Deserialize, serde::Serialize)]
pub struct Relationship {
    from: Id,
    to: Id,
    relationship: TagId,
    handle_pos: Point2<f32>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    evidence: Vec<Evidence>,
}
impl Relationship {
    fn ui(
        &mut self,
        ui: &mut Ui,
        id: Id,
        from_position: Point2<f32>,
        to_position: Point2<f32>,
    ) -> bool {
        true // to keep this alive
    }
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct Evidence {
    source: String,
    #[serde(default)]
    snippet: String,
}

pub struct Radial {
    screen_center: Point2<f32>,
    id: Id,
    is_thing: bool,
}
impl Radial {
    fn ui(&mut self, ui: &mut Ui) -> bool {
        const DEADZONE: f32 = 10.0;
        let painter = ui.layer_painter(LayerId::new(Order::Foreground, "radial".into()));
        let screen_center: Pos2 = self.screen_center.into();
        let ptr = ui
            .input(|i| i.pointer.latest_pos())
            .unwrap_or(screen_center);
        let v: Vec2 = ptr - screen_center;

        let right_click_released =
            ui.input(|i| i.pointer.button_released(PointerButton::Secondary));
        if v.length() < DEADZONE && right_click_released {
            return false;
        }

        // let a = v.angle(); // -π..π, cw from +X
        // let n = items.len() as f32;
        // let idx = ((a / TAU * n).rem_euclid(n) + 0.5).floor() as usize % items.len();

        // if ctx.input(|i| i.pointer.button_released(PointerButton::Secondary)) {
        //     commit(hovered);
        //     self.radial = None;
        // }
        true
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct InferencesApp {
    view_rect: Rect,
    id_counter: IdCounter,
    things: IndexMap<Id, Thing>,
    relationships: IndexMap<Id, Relationship>,
    tags: IndexMap<TagId, Tag>,
    #[serde(skip)]
    radial: Option<Radial>,
}
impl Default for InferencesApp {
    fn default() -> Self {
        Self {
            view_rect: Rect::from_center_size([0.0; 2].into(), [512.0; 2].into()),
            id_counter: Default::default(),
            things: IndexMap::default(),
            relationships: IndexMap::default(),
            tags: IndexMap::default(),
            radial: None,
        }
    }
}
impl InferencesApp {
    pub fn restore(cc: &eframe::CreationContext<'_>) -> Self {
        if let Some(storage) = cc.storage {
            eframe::get_value(storage, eframe::APP_KEY).unwrap_or_default()
        } else {
            Default::default()
        }
    }
}
impl App for InferencesApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let view_rect = self.view_rect;
        Scene::new()
            .zoom_range(0.5..=1.0)
            .drag_pan_buttons(DragPanButtons::MIDDLE)
            .show(ui, &mut self.view_rect, |ui| {
                // add new node
                if let Some(release_pos) = ui.input(|i| {
                    i.pointer
                        .secondary_released()
                        .then_some(i.pointer.latest_pos())
                        .flatten()
                }) {
                    let new_position = ui
                        .layer_transform_from_global(ui.layer_id())
                        .unwrap_or_default()
                        * release_pos;
                    self.things.insert(
                        self.id_counter.new_id(),
                        Thing {
                            name: "".into(),
                            color: Color32::WHITE,
                            position: [new_position.x, new_position.y].into(),
                            editor_pos: None,
                            pinned: false,
                        },
                    );
                }
                draw_grid(ui, view_rect);
                self.relationships.retain(|id, relationship| {
                    if relationship.from == relationship.to {
                        return false;
                    }
                    let Some(from_thing) = self.things.get(&relationship.from) else {
                        return false;
                    };
                    let Some(to_thing) = self.things.get(&relationship.from) else {
                        return false;
                    };
                    relationship.ui(ui, *id, from_thing.position, to_thing.position)
                });
                self.things.retain(|id, thing| thing.ui(ui, *id));
            });
    }

    fn auto_save_interval(&self) -> Duration {
        Duration::from_secs(5)
    }
}
fn draw_grid(ui: &mut Ui, view: Rect) {
    let painter = ui.painter();
    let to_window = ui
        .layer_transform_to_global(ui.layer_id())
        .unwrap_or_default();
    let zoom = to_window.scaling.max(1e-6);
    let step = 2f32.powf((60.0 / zoom).log2().round());
    let stroke =
        |alpha: f32| Stroke::new(1.0 / zoom, Color32::from_gray(128).gamma_multiply(alpha));

    for (s, a) in [(step, 0.10), (step * 4.0, 0.22)] {
        let mut x = (view.left() / s).floor() * s;
        while x <= view.right() {
            painter.vline(x, view.y_range(), stroke(a));
            x += s;
        }
        let mut y = (view.top() / s).floor() * s;
        while y <= view.bottom() {
            painter.hline(view.x_range(), y, stroke(a));
            y += s;
        }
    }
}
