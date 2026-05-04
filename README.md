# SmartQueue

**De-shittified Office Hours!**

SmartQueue is a queue management system designed to make university office hours less painful for students and TAs. We built it as a semester-long project at the University of Toronto, going through a full user-centered design process from background research and personas all the way through to a high-fidelity prototype and summative usability evaluation.

The core problem is pretty straightforward: office hours are one of the most important touchpoints for student learning, but they're often overcrowded, unstructured, and stressful. Students don't know how long they'll wait, TAs get the same questions over and over, and quieter students get drowned out. SmartQueue tries to fix that by giving both sides better tools and better information.

Check out the demo [here](https://smartqueue-demo.netlify.app/)! We setup 4 demo student accounts (student1:root1234, ..., student4:root1234) and one demo TA account (admin:root1234).

And for the design process, methodology, earlier prototypes and more check out the project website [here](https://smartqueuecsc318.netlify.app/) :\)

## What it does

SmartQueue is built around five design requirements we identified through our initial user research, which included interviews, contextual inquiry, and persona development:

1. **Dynamic Wait-Time Estimation** — students can see queue depth, average service time, and estimated wait before deciding whether to show up
2. **Structured Question Intake** — a ticket submission form that asks for topic, related assignment, a question summary, and help type (Quick Check vs. Deep Dive), so TAs have context before the interaction starts
3. **Thematic Clustering & Aggregation** — topic tags on tickets so TAs can identify common themes and batch similar questions
4. **Public Active Question Visibility** — students in the queue can see what's currently being discussed, which supports passive learning while waiting
5. **Hybrid Queue Management** — supports both in-person and remote students in the same session

## Process

We followed a three-phase design process. In the **research phase**, we conducted background research into office hours dynamics, ran user interviews, and synthesized our findings into personas and job stories that framed the five design requirements above.

In the **exploration and prototyping phase**, we generated three distinct design alternatives (a single ticket queue, topic-based rooms, and an asynchronous triage system), compared them against the requirements, and converged on the single ticket queue model. We sketched and paper-prototyped this direction, then ran an expert evaluation with heuristic walkthroughs that surfaced issues around queue status clarity and confusing interface language, which we iterated on before moving to high-fidelity.

In the **evaluation phase**, we built the full high-fidelity prototype and ran a summative usability evaluation with 11 participants across four task scenarios. The system scored an average SUS of 89.6 (Grade A/Excellent), and the structured intake flow had a 100% task completion rate across all participants. For more detailed information on our evals and more feel free to check out our [website](https://smartqueuecsc318.netlify.app/) again.

## Team

- Andrew Goh — low and high-fidelity prototype implementations, subsequent development (embedding, clustering, etc.)
- Sean Jackson — evaluation design, facilitation, report integration
- Rohan Aslam — front-end prototype, refinement, bug fixing
- Matthew DeMarinis — data collection, aggregation, convergence rationale
- Samil Dhawan ([github](https://github.com/samildhawan)) — results analysis, interpretation, design implications

## Tech

The prototype was built as a React application, prioritizing a frontend-first, UX-led approach. Persistent storage was set up to support different user permissions and parallel access during usability testing.
