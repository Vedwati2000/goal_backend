const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

const studentSchema = new mongoose.Schema({
  name: String,
  email: String,
  grade: String,
  createdAt: { type: Date, default: Date.now }
});

const goalSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  studentName: String,
  goalText: String,
  inputMethod: { type: String, enum: ['speech', 'text'] },
  category: String,
  targetDate: Date,
  status: { type: String, enum: ['active', 'completed', 'missed'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

const reflectionSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  studentName: String,
  goalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Goal' },
  reflectionText: String,
  inputMethod: { type: String, enum: ['speech', 'text'] },
  aiFeedback: String,
  createdAt: { type: Date, default: Date.now }
});

const Student = mongoose.model('Student', studentSchema);
const Goal = mongoose.model('Goal', goalSchema);
const Reflection = mongoose.model('Reflection', reflectionSchema);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const student = new Student(req.body);
    await student.save();
    res.json(student);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const students = await Student.find();
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/goals', async (req, res) => {
  try {
    const { goalText, studentId, studentName, inputMethod, category, targetDate } = req.body;

    let correctedText = goalText;
    if (inputMethod === 'text') {
      const correction = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are a grammar checker. Correct the grammar and spelling of the following text. Return only the corrected text without explanations.'
          },
          { role: 'user', content: goalText }
        ],
        model: "openai/gpt-oss-120b",
        temperature: 0.3
      });
      correctedText = correction.choices[0].message.content.trim();
    }

    const goal = new Goal({
      studentId,
      studentName,
      goalText: correctedText,
      inputMethod,
      category,
      targetDate
    });

    await goal.save();
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/goals/:studentId', async (req, res) => {
  try {
    const goals = await Goal.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/goals/:goalId', async (req, res) => {
  try {
    const goal = await Goal.findByIdAndUpdate(
      req.params.goalId,
      { status: req.body.status, completedAt: req.body.status === 'completed' ? new Date() : null },
      { new: true }
    );
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reflections', async (req, res) => {
  try {
    const { reflectionText, studentId, studentName, goalId, inputMethod } = req.body;

    let correctedText = reflectionText;
    if (inputMethod === 'text') {
      const correction = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are a grammar checker. Correct the grammar and spelling of the following text. Return only the corrected text without explanations.'
          },
          { role: 'user', content: reflectionText }
        ],
        model: "openai/gpt-oss-120b",
        temperature: 0.3
      });
      correctedText = correction.choices[0].message.content.trim();
    }

    const aiFeedback = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are an educational AI assistant. Provide constructive feedback on student reflections. Be encouraging and specific. Keep it concise under 100 words.'
        },
        { role: 'user', content: `Reflection: ${correctedText}` }
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.7
    });

    const reflection = new Reflection({
      studentId,
      studentName,
      goalId,
      reflectionText: correctedText,
      inputMethod,
      aiFeedback: aiFeedback.choices[0].message.content
    });

    await reflection.save();
    res.json(reflection);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reflections/:studentId', async (req, res) => {
  try {
    const reflections = await Reflection.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
    res.json(reflections);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/check-grammar', async (req, res) => {
  try {
    const { text } = req.body;
    const correction = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a grammar checker. Correct grammar and spelling. Return only the corrected text.'
        },
        { role: 'user', content: text }
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.3
    });
    res.json({ correctedText: correction.choices[0].message.content.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    const totalStudents = await Student.countDocuments();
    const totalGoals = await Goal.countDocuments();
    const completedGoals = await Goal.countDocuments({ status: 'completed' });
    const activeGoals = await Goal.countDocuments({ status: 'active' });
    const missedGoals = await Goal.countDocuments({ status: 'missed' });
    const totalReflections = await Reflection.countDocuments();

    const studentsWithGoals = await Goal.distinct('studentId');
    const studentsWithoutGoals = totalStudents - studentsWithGoals.length;

    const goalStats = await Goal.aggregate([
      {
        $group: {
          _id: '$studentId',
          studentName: { $first: '$studentName' },
          goalCount: { $sum: 1 },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
        }
      }
    ]);

    res.json({
      totalStudents,
      totalGoals,
      completedGoals,
      activeGoals,
      missedGoals,
      totalReflections,
      studentsWithGoals: studentsWithGoals.length,
      studentsWithoutGoals,
      completionRate: totalGoals > 0 ? ((completedGoals / totalGoals) * 100).toFixed(1) : 0,
      goalStats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai-evaluate-students', async (req, res) => {
  try {
    const students = await Student.find();
    const goals = await Goal.find();
    const reflections = await Reflection.find();

    const studentData = students.map(student => {
      const studentGoals = goals.filter(g => g.studentId.toString() === student._id.toString());
      const studentReflections = reflections.filter(r => r.studentId.toString() === student._id.toString());

      return {
        name: student.name,
        goalCount: studentGoals.length,
        completedGoals: studentGoals.filter(g => g.status === 'completed').length,
        reflectionCount: studentReflections.length,
        goals: studentGoals.map(g => ({ text: g.goalText, status: g.status }))
      };
    });

    const evaluation = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are an educational analytics AI. Analyze student goal-setting and reflection data. Provide insights on engagement, completion rates, and recommendations. Be concise and actionable. Also include a Root Cause Analysis (RCA) section listing 5 specific reasons why some students are not setting goals, based on the data provided. IMPORTANT: Do NOT use any markdown formatting. Do NOT use asterisks (*), hash symbols (#), or any other markdown characters in your response. Return plain text only.'
        },
        { role: 'user', content: JSON.stringify(studentData) }
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.5,
      max_tokens: 8000
    });

    res.json({ evaluation: evaluation.choices[0].message.content, studentData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

cron.schedule('0 9 * * *', async () => {
  try {
    const students = await Student.find();
    const goals = await Goal.find({ status: 'active' });

    for (const student of students) {
      const studentGoals = goals.filter(g => g.studentId.toString() === student._id.toString());

      if (studentGoals.length === 0 && student.email) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: student.email,
          subject: 'Goal Setting Reminder',
          html: `<h2>Hi ${student.name}</h2><p>You haven't set any goals yet. Please log in and set your goals for this week.</p>`
        });
      } else {
        const overdueGoals = studentGoals.filter(g => new Date(g.targetDate) < new Date());
        for (const goal of overdueGoals) {
          await Goal.findByIdAndUpdate(goal._id, { status: 'missed' });
        }
      }
    }
  } catch (error) {
    console.error('Cron job error:', error);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});