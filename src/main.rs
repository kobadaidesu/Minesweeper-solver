mod game;

use eframe::egui::{
    self, vec2, Align, Align2, Color32, FontId, Pos2, Rect, RichText, Sense, Slider, Stroke,
    StrokeKind, Vec2,
};
use game::{GameState, Minesweeper, RuleType, SolverStep, StepType};
use std::time::{Duration, Instant};

const PRESETS: &[(&str, usize, usize, usize)] = &[
    ("初級", 9, 9, 10),
    ("中級", 16, 16, 40),
    ("上級", 30, 16, 99),
    ("大", 50, 50, 400),
    ("超大", 100, 100, 2000),
];
const VISIBLE_FAST_STEPS_PER_FRAME: usize = 8;
const REVEAL_GLOW_SECONDS: f32 = 0.65;
const MAX_CELL_EFFECTS: usize = 180;

#[derive(Clone, Copy)]
enum CellEffectKind {
    Reveal,
    Flag,
    Mine,
}

struct CellEffect {
    index: usize,
    started_at: Instant,
    kind: CellEffectKind,
}

struct MinesweeperApp {
    game: Minesweeper,
    input_width: usize,
    input_height: usize,
    input_mines: usize,
    pending_steps: Vec<SolverStep>,
    next_step_index: usize,
    next_step_at: Option<Instant>,
    is_animating: bool,
    current_combo: usize,
    max_combo: usize,
    combo_reset_at: Option<Instant>,
    started_at: Option<Instant>,
    finished_elapsed: Option<Duration>,
    status_message: String,
    cell_effects: Vec<CellEffect>,
}

impl Default for MinesweeperApp {
    fn default() -> Self {
        let game = Minesweeper::new(16, 16, 40);
        Self {
            game,
            input_width: 16,
            input_height: 16,
            input_mines: 40,
            pending_steps: Vec::new(),
            next_step_index: 0,
            next_step_at: None,
            is_animating: false,
            current_combo: 0,
            max_combo: 0,
            combo_reset_at: None,
            started_at: None,
            finished_elapsed: None,
            status_message: "セルをクリックして開始".to_owned(),
            cell_effects: Vec::new(),
        }
    }
}

impl MinesweeperApp {
    fn new_game(&mut self, width: usize, height: usize, mines: usize) {
        let (width, height, mines) = Minesweeper::sanitize_settings(width, height, mines);
        self.game = Minesweeper::new(width, height, mines);
        self.input_width = width;
        self.input_height = height;
        self.input_mines = mines;
        self.pending_steps.clear();
        self.next_step_index = 0;
        self.next_step_at = None;
        self.is_animating = false;
        self.current_combo = 0;
        self.max_combo = 0;
        self.combo_reset_at = None;
        self.started_at = None;
        self.finished_elapsed = None;
        self.status_message = "セルをクリックして開始".to_owned();
        self.cell_effects.clear();
    }

    fn apply_preset(&mut self, width: usize, height: usize, mines: usize) {
        self.new_game(width, height, mines);
    }

    fn handle_cell_click(&mut self, index: usize) {
        if self.is_animating || matches!(self.game.game_state, GameState::Won | GameState::Lost) {
            return;
        }
        if self.game.cells[index].is_flagged {
            return;
        }

        let coords = self.game.index_to_coords(index);
        self.game
            .add_log(format!("プレイヤーが {coords} をクリック"), RuleType::Info);
        let was_ready = self.game.game_state == GameState::Ready;
        let _ = self.game.reveal_cell(index);
        self.add_cell_effect(index, CellEffectKind::Reveal);
        if was_ready {
            self.started_at = Some(Instant::now());
        }

        match self.game.game_state {
            GameState::Lost => {
                self.add_cell_effect(index, CellEffectKind::Mine);
                self.finish_timer();
                self.status_message = "地雷を踏みました".to_owned();
            }
            GameState::Playing => {
                self.pending_steps = self.game.collect_solving_steps();
                self.next_step_index = 0;
                self.is_animating = !self.pending_steps.is_empty();
                self.next_step_at = Some(Instant::now());
                self.current_combo = 0;
                if !self.is_animating {
                    self.finish_turn();
                }
            }
            _ => {}
        }
    }

    fn handle_cell_right_click(&mut self, index: usize) {
        if self.is_animating {
            return;
        }
        self.game.flag_cell(index);
        self.add_cell_effect(index, CellEffectKind::Flag);
    }

    fn advance_animation(&mut self, ctx: &egui::Context) {
        if !self.is_animating {
            if let Some(reset_at) = self.combo_reset_at {
                if Instant::now() >= reset_at {
                    self.current_combo = 0;
                    self.combo_reset_at = None;
                } else {
                    ctx.request_repaint_after(reset_at.saturating_duration_since(Instant::now()));
                }
            }
            return;
        }

        if self.game.animation_speed_ms <= 0.0 {
            for _ in 0..VISIBLE_FAST_STEPS_PER_FRAME {
                let Some(step) = self.pending_steps.get(self.next_step_index).cloned() else {
                    break;
                };
                self.apply_pending_step(step);
                self.next_step_index += 1;
            }
            if self.next_step_index >= self.pending_steps.len() {
                self.finish_animation();
            }
            ctx.request_repaint();
            return;
        }

        let now = Instant::now();
        let next_step_at = self.next_step_at.unwrap_or(now);
        if now < next_step_at {
            ctx.request_repaint_after(next_step_at.saturating_duration_since(now));
            return;
        }

        if let Some(step) = self.pending_steps.get(self.next_step_index).cloned() {
            self.apply_pending_step(step);
            self.next_step_index += 1;
            self.next_step_at =
                Some(now + Duration::from_secs_f32(self.game.animation_speed_ms / 1000.0));
            ctx.request_repaint();
            return;
        }

        self.finish_animation();
    }

    fn apply_pending_step(&mut self, step: SolverStep) {
        let changed_count = self.game.apply_solver_step(&step);
        if step.step_type == StepType::Reveal {
            self.current_combo += changed_count;
            self.max_combo = self.max_combo.max(self.current_combo);
        }
        let kind = match step.step_type {
            StepType::Reveal => CellEffectKind::Reveal,
            StepType::Flag => CellEffectKind::Flag,
        };
        self.add_cell_effects(&step.cells, kind);
        self.status_message = step.log.message;
    }

    fn add_cell_effects(&mut self, indices: &[usize], kind: CellEffectKind) {
        for &index in indices.iter().take(MAX_CELL_EFFECTS) {
            self.add_cell_effect(index, kind);
        }
    }

    fn add_cell_effect(&mut self, index: usize, kind: CellEffectKind) {
        if self.cell_effects.len() >= MAX_CELL_EFFECTS {
            let overflow = self.cell_effects.len() + 1 - MAX_CELL_EFFECTS;
            self.cell_effects.drain(0..overflow);
        }
        self.cell_effects.push(CellEffect {
            index,
            started_at: Instant::now(),
            kind,
        });
    }

    fn prune_cell_effects(&mut self) {
        let now = Instant::now();
        self.cell_effects.retain(|effect| {
            now.duration_since(effect.started_at).as_secs_f32() < REVEAL_GLOW_SECONDS
        });
    }

    fn finish_animation(&mut self) {
        self.pending_steps.clear();
        self.next_step_index = 0;
        self.next_step_at = None;
        self.is_animating = false;
        if self.current_combo > 0 {
            self.combo_reset_at = Some(Instant::now() + Duration::from_secs(1));
        }
        self.finish_turn();
    }

    fn finish_turn(&mut self) {
        if self.game.check_win() {
            self.finish_timer();
            self.status_message = "クリア！".to_owned();
        }
    }

    fn finish_timer(&mut self) {
        if self.finished_elapsed.is_none() {
            if let Some(started_at) = self.started_at {
                self.finished_elapsed = Some(started_at.elapsed());
            }
        }
    }

    fn elapsed_seconds(&self) -> u64 {
        if let Some(elapsed) = self.finished_elapsed {
            elapsed.as_secs()
        } else if let Some(started_at) = self.started_at {
            started_at.elapsed().as_secs()
        } else {
            0
        }
    }

    fn progress_color(&self) -> Color32 {
        let progress = self.game.progress();
        if progress >= 0.875 {
            Color32::from_rgb(73, 142, 182)
        } else if progress >= 0.75 {
            Color32::from_rgb(12, 90, 140)
        } else if progress >= 0.625 {
            Color32::from_rgb(12, 56, 100)
        } else if progress >= 0.5 {
            Color32::from_rgb(13, 34, 70)
        } else if progress >= 0.375 {
            Color32::from_rgb(18, 22, 43)
        } else if progress >= 0.25 {
            Color32::from_rgb(24, 22, 33)
        } else if progress >= 0.125 {
            Color32::from_rgb(24, 22, 32)
        } else {
            Color32::from_rgb(20, 20, 24)
        }
    }

    fn top_panel(&mut self, root_ui: &mut egui::Ui) {
        egui::Panel::top("top_panel").show_inside(root_ui, |ui| {
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                ui.heading("Semi-Automatic Minesweeper");
                ui.separator();
                ui.label(
                    RichText::new(&self.status_message).color(Color32::from_rgb(210, 214, 220)),
                );
                ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                    ui.label(format!("Time {:03}", self.elapsed_seconds().min(999)));
                    ui.label(format!("Mines {}", self.game.get_remaining_mines()));
                });
            });

            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                ui.label("幅");
                ui.add(
                    egui::DragValue::new(&mut self.input_width)
                        .range(5..=100)
                        .speed(1),
                );
                ui.label("高さ");
                ui.add(
                    egui::DragValue::new(&mut self.input_height)
                        .range(5..=100)
                        .speed(1),
                );
                ui.label("地雷");
                ui.add(
                    egui::DragValue::new(&mut self.input_mines)
                        .range(1..=9_999)
                        .speed(1),
                );
                if ui.button("新しいゲーム").clicked() {
                    self.new_game(self.input_width, self.input_height, self.input_mines);
                }

                ui.separator();
                for &(label, width, height, mines) in PRESETS {
                    if ui.button(label).clicked() {
                        self.apply_preset(width, height, mines);
                    }
                }
            });

            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.label("解答速度");
                ui.add(Slider::new(&mut self.game.animation_speed_ms, 0.0..=100.0).suffix(" ms"));
                if ui.button("最速").clicked() {
                    self.game.animation_speed_ms = 0.0;
                }
                if ui.button("高速").clicked() {
                    self.game.animation_speed_ms = 1.0;
                }
                if ui.button("標準").clicked() {
                    self.game.animation_speed_ms = 100.0;
                }
                let revealed = self.game.clear_count;
                let non_mine = self.game.width * self.game.height - self.game.total_mines;
                let percent = (self.game.progress() * 100.0).floor() as usize;
                ui.separator();
                ui.label(format!("{revealed} / {non_mine} ({percent}%)"));
                ui.separator();
                ui.label(format!(
                    "COMBO {} / 最大 {}",
                    self.current_combo, self.max_combo
                ));
            });

            ui.add_space(6.0);
            let progress = self.game.progress().clamp(0.0, 1.0);
            ui.add(egui::ProgressBar::new(progress).desired_width(ui.available_width()));
            ui.add_space(6.0);
        });
    }

    fn log_panel(&mut self, root_ui: &mut egui::Ui) {
        egui::Panel::right("log_panel")
            .default_size(360.0)
            .resizable(true)
            .show_inside(root_ui, |ui| {
                ui.heading("推論ログ");
                ui.separator();
                egui::ScrollArea::vertical()
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        for entry in &self.game.reasoning_log {
                            let color = match entry.rule_type {
                                RuleType::Info => Color32::from_gray(170),
                                RuleType::Rule1 => Color32::from_rgb(95, 180, 110),
                                RuleType::Rule2 => Color32::from_rgb(220, 130, 95),
                                RuleType::Rule3 => Color32::from_rgb(120, 165, 230),
                                RuleType::Rule4 => Color32::from_rgb(220, 190, 90),
                            };
                            ui.horizontal_wrapped(|ui| {
                                ui.label(
                                    RichText::new(entry.rule_type.label()).color(color).strong(),
                                );
                                ui.label(&entry.message);
                            });
                            ui.add_space(4.0);
                        }
                    });
            });
    }

    fn board_panel(&mut self, root_ui: &mut egui::Ui) {
        egui::CentralPanel::default()
            .frame(egui::Frame::default().fill(self.progress_color()))
            .show_inside(root_ui, |ui| {
                ui.add_space(10.0);
                egui::ScrollArea::both()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        self.draw_board(ui);
                    });
            });
    }

    fn draw_board(&mut self, ui: &mut egui::Ui) {
        self.prune_cell_effects();
        if !self.cell_effects.is_empty() {
            ui.ctx().request_repaint_after(Duration::from_millis(16));
        }

        let available = ui.available_size();
        let cell_size = (available.x / self.game.width as f32)
            .min((available.y - 16.0).max(15.0) / self.game.height as f32)
            .clamp(15.0, 30.0);
        let board_size = vec2(
            self.game.width as f32 * cell_size,
            self.game.height as f32 * cell_size,
        );

        let (rect, response) = ui.allocate_exact_size(board_size, Sense::click());
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect.expand(2.0), 4.0, Color32::from_rgb(105, 105, 105));

        if response.clicked_by(egui::PointerButton::Primary) {
            if let Some(index) =
                self.pointer_to_index(response.interact_pointer_pos(), rect, cell_size)
            {
                self.handle_cell_click(index);
            }
        }
        if response.clicked_by(egui::PointerButton::Secondary) {
            if let Some(index) =
                self.pointer_to_index(response.interact_pointer_pos(), rect, cell_size)
            {
                self.handle_cell_right_click(index);
            }
        }

        for cell in &self.game.cells {
            let x = cell.index % self.game.width;
            let y = cell.index / self.game.width;
            let min = Pos2::new(
                rect.left() + x as f32 * cell_size,
                rect.top() + y as f32 * cell_size,
            );
            let cell_rect = Rect::from_min_size(min, Vec2::splat(cell_size));
            self.paint_cell(&painter, cell_rect, cell.index, cell_size);
        }
    }

    fn pointer_to_index(&self, pos: Option<Pos2>, rect: Rect, cell_size: f32) -> Option<usize> {
        let pos = pos?;
        if !rect.contains(pos) {
            return None;
        }
        let x = ((pos.x - rect.left()) / cell_size).floor() as usize;
        let y = ((pos.y - rect.top()) / cell_size).floor() as usize;
        if x < self.game.width && y < self.game.height {
            Some(y * self.game.width + x)
        } else {
            None
        }
    }

    fn paint_cell(&self, painter: &egui::Painter, rect: Rect, index: usize, cell_size: f32) {
        let cell = &self.game.cells[index];
        let inner = rect.shrink(0.5);
        let effect = self.cell_effect(index);

        if cell.is_revealed {
            let mut fill = if cell.has_mine {
                Color32::from_rgb(210, 70, 60)
            } else {
                Color32::from_rgb(224, 224, 224)
            };
            if let Some((kind, intensity)) = effect {
                fill = blend_color(fill, effect_color(kind), intensity * 0.32);
            }
            painter.rect_filled(inner, 0.0, fill);
            painter.rect_stroke(
                inner,
                0.0,
                Stroke::new(1.0, Color32::from_rgb(150, 150, 150)),
                StrokeKind::Inside,
            );

            if cell.has_mine {
                self.paint_text(painter, inner, "*", Color32::WHITE, cell_size);
            } else if cell.neighbor_mines > 0 {
                self.paint_text(
                    painter,
                    inner,
                    &cell.neighbor_mines.to_string(),
                    number_color(cell.neighbor_mines),
                    cell_size,
                );
            }
        } else {
            let fill = if cell.is_flagged {
                Color32::from_rgb(255, 152, 0)
            } else {
                Color32::from_rgb(187, 187, 187)
            };
            painter.rect_filled(inner, 0.0, fill);
            painter.rect_stroke(
                inner,
                0.0,
                Stroke::new(2.0, Color32::from_rgb(224, 224, 224)),
                StrokeKind::Inside,
            );
            if cell.is_flagged {
                self.paint_text(painter, inner, "!", Color32::WHITE, cell_size);
            }
        }

        if let Some((kind, intensity)) = effect {
            self.paint_cell_glow(painter, inner, cell_size, kind, intensity);
        }
    }

    fn cell_effect(&self, index: usize) -> Option<(CellEffectKind, f32)> {
        let now = Instant::now();
        self.cell_effects
            .iter()
            .rev()
            .find(|effect| effect.index == index)
            .and_then(|effect| {
                let age = now.duration_since(effect.started_at).as_secs_f32();
                if age >= REVEAL_GLOW_SECONDS {
                    None
                } else {
                    Some((effect.kind, 1.0 - age / REVEAL_GLOW_SECONDS))
                }
            })
    }

    fn paint_cell_glow(
        &self,
        painter: &egui::Painter,
        rect: Rect,
        cell_size: f32,
        kind: CellEffectKind,
        intensity: f32,
    ) {
        let color = effect_color(kind);
        let alpha = (72.0 * intensity).round().clamp(0.0, 72.0) as u8;
        let glow = Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha);
        let radius = (cell_size * (0.12 + 0.18 * intensity)).max(2.0);
        painter.rect_filled(rect.expand(radius), 3.0, glow);
        painter.rect_stroke(
            rect.expand(radius * 0.35),
            2.0,
            Stroke::new((2.0 * intensity).max(0.6), color),
            StrokeKind::Outside,
        );
    }

    fn paint_text(
        &self,
        painter: &egui::Painter,
        rect: Rect,
        text: &str,
        color: Color32,
        cell_size: f32,
    ) {
        painter.text(
            rect.center(),
            Align2::CENTER_CENTER,
            text,
            FontId::proportional((cell_size * 0.62).max(8.0)),
            color,
        );
    }
}

impl eframe::App for MinesweeperApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.advance_animation(&ctx);
        if self.started_at.is_some() && self.finished_elapsed.is_none() {
            ui.ctx().request_repaint_after(Duration::from_millis(250));
        }
        self.top_panel(ui);
        self.log_panel(ui);
        self.board_panel(ui);
    }
}

fn number_color(number: u8) -> Color32 {
    match number {
        1 => Color32::from_rgb(0, 0, 255),
        2 => Color32::from_rgb(0, 128, 0),
        3 => Color32::from_rgb(255, 0, 0),
        4 => Color32::from_rgb(0, 0, 128),
        5 => Color32::from_rgb(128, 0, 0),
        6 => Color32::from_rgb(0, 128, 128),
        7 => Color32::BLACK,
        8 => Color32::from_rgb(128, 128, 128),
        _ => Color32::BLACK,
    }
}

fn effect_color(kind: CellEffectKind) -> Color32 {
    match kind {
        CellEffectKind::Reveal => Color32::from_rgb(180, 235, 150),
        CellEffectKind::Flag => Color32::from_rgb(255, 190, 80),
        CellEffectKind::Mine => Color32::from_rgb(255, 95, 80),
    }
}

fn blend_color(base: Color32, highlight: Color32, amount: f32) -> Color32 {
    let amount = amount.clamp(0.0, 1.0);
    let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * amount).round() as u8;
    Color32::from_rgb(
        mix(base.r(), highlight.r()),
        mix(base.g(), highlight.g()),
        mix(base.b(), highlight.b()),
    )
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Semi-Automatic Minesweeper")
            .with_inner_size([1280.0, 820.0])
            .with_min_inner_size([900.0, 640.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Semi-Automatic Minesweeper",
        options,
        Box::new(|_cc| Ok(Box::<MinesweeperApp>::default())),
    )
}
