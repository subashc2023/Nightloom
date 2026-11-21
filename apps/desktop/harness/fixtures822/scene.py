from manim import *

class Name(Scene):
    def construct(self):
        c = Circle(color=BLUE)
        s = Square(color=GREEN)
        t = Text("Nightloom 822").to_edge(UP)
        self.play(Write(t), run_time=1)
        self.play(Create(c), run_time=1.5)
        self.play(Transform(c, s), run_time=1.5)
        self.play(c.animate.rotate(PI / 2), run_time=1)
